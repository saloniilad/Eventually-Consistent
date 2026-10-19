import { createServer as createHttpServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Config } from './config';
import { SessionManager } from './docs/manager';
import { createApp } from './http/app';
import type { Store } from './store/types';
import { attachWebSocket } from './ws/server';

export interface RunningServer {
  http: Server;
  sessions: SessionManager;
  port: number;
  stop(): Promise<void>;
}

/** Wire store + sessions + HTTP API + WebSocket together and start listening. */
export async function startServer(config: Config, store: Store): Promise<RunningServer> {
  const sessions = new SessionManager(store, {
    snapshotEvery: config.snapshotEvery,
    maxDocChars: config.maxDocChars,
  });
  const ctx = { config, store, sessions };
  const http = createHttpServer(createApp(ctx));
  const ws = attachWebSocket(http, ctx);
  await new Promise<void>((resolve) => http.listen(config.port, resolve));
  const port = (http.address() as AddressInfo).port;
  return {
    http,
    sessions,
    port,
    async stop() {
      await ws.close(); // closes sockets -> sessions release -> final snapshots
      await new Promise((r) => setTimeout(r, 50));
      await sessions.closeAll();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
