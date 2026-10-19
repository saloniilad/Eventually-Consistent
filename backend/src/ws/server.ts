import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { AppContext } from '../http/app';
import { verifyToken } from '../http/auth';
import type { DocumentSession } from '../docs/session';
import { ClientConn, ProtocolError } from '../docs/session';
import { log } from '../util/logger';
import { ClientMessage, ClientMessageSchema, ServerMessage } from './protocol';

const MAX_PAYLOAD = 1024 * 1024;
const HEARTBEAT_MS = 30_000;
const BURST = 300;
const REFILL_PER_SEC = 150;

/** Attach a WebSocket endpoint at /ws?token=<jwt> to an existing HTTP server. */
export function attachWebSocket(http: HttpServer, ctx: AppContext): { close(): Promise<void> } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  http.on('upgrade', (req, socket: Duplex, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const user =
      url.pathname === '/ws'
        ? verifyToken(url.searchParams.get('token') ?? '', ctx.config.jwtSecret)
        : null;
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, user, ctx));
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const w = ws as WebSocket & { alive?: boolean };
      if (w.alive === false) {
        ws.terminate();
        continue;
      }
      w.alive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        for (const ws of wss.clients) ws.close(1001, 'server shutting down');
        wss.close(() => resolve());
      }),
  };
}

function handleConnection(
  ws: WebSocket,
  user: { id: string; name: string },
  ctx: AppContext,
): void {
  const w = ws as WebSocket & { alive?: boolean };
  w.alive = true;
  ws.on('pong', () => {
    w.alive = true;
  });

  const send = (msg: ServerMessage): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  const sendError = (code: string, message: string): void => send({ type: 'error', code, message });

  let joined: { session: DocumentSession; conn: ClientConn; docId: string } | null = null;
  let tokens = BURST;
  let last = Date.now();
  let chain: Promise<void> = Promise.resolve();

  async function onMessage(msg: ClientMessage): Promise<void> {
    if (msg.type === 'ping') return send({ type: 'pong' });

    if (msg.type === 'join') {
      if (joined) return sendError('already_joined', 'this connection already joined a document');
      if (!msg.siteId.startsWith(`${user.id}~`)) {
        return sendError('bad_site', 'siteId must start with "<your user id>~"');
      }
      const role = await ctx.store.getRole(msg.docId, user.id);
      if (!role) {
        sendError('forbidden', 'no access to this document');
        return ws.close(4403, 'forbidden');
      }
      const session = await ctx.sessions.acquire(msg.docId);
      const conn: ClientConn = {
        id: randomUUID(),
        userId: user.id,
        name: user.name,
        siteId: msg.siteId,
        role,
        send,
      };
      joined = { session, conn, docId: msg.docId };
      if (ws.readyState !== WebSocket.OPEN) return; // closed while loading; 'close' handler cleans up
      await session.join(conn, msg.since);
      return;
    }

    if (!joined) return sendError('not_joined', 'send a join message first');
    const { session, conn } = joined;
    switch (msg.type) {
      case 'ops':
        return session.submit(conn, msg.ops, msg.msgId);
      case 'undo':
      case 'redo':
        return session.undoRedo(conn, msg.type);
      case 'presence':
        return session.setPresence(conn, msg.cursor);
    }
  }

  ws.on('message', (data, isBinary) => {
    const now = Date.now();
    tokens = Math.min(BURST, tokens + ((now - last) / 1000) * REFILL_PER_SEC) - 1;
    last = now;
    if (tokens < 0) {
      // Dropping ops silently would break convergence; closing makes the client resync.
      return ws.close(4429, 'rate limit exceeded');
    }
    if (isBinary) return sendError('bad_message', 'binary frames are not supported');
    let json: unknown;
    try {
      json = JSON.parse(data.toString());
    } catch {
      return sendError('bad_message', 'invalid JSON');
    }
    const parsed = ClientMessageSchema.safeParse(json);
    if (!parsed.success) {
      return sendError(
        'bad_message',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }
    // Process strictly in arrival order per connection.
    chain = chain
      .then(() => onMessage(parsed.data))
      .catch((err) => {
        if (err instanceof ProtocolError) return sendError(err.code, err.message);
        log.error('ws handler failed', { err: String(err) });
        sendError('internal', 'internal error');
      });
  });

  ws.on('close', () => {
    chain = chain.then(async () => {
      if (!joined) return;
      const { session, conn, docId } = joined;
      joined = null;
      session.leave(conn);
      await ctx.sessions.release(docId);
    });
  });

  ws.on('error', (err) => log.warn('ws error', { err: String(err) }));
}
