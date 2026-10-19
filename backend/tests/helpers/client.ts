import { WebSocket } from 'ws';
import { Op, Rga } from '../../src/crdt/rga';

export interface Account {
  token: string;
  user: { id: string; name: string; email: string };
}

export async function api(
  base: string,
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
) {
  const res = await fetch(base + path, {
    method: opts.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  return { status: res.status, json };
}

let counter = 0;
export async function register(base: string, name: string): Promise<Account> {
  const r = await api(base, '/api/auth/register', {
    method: 'POST',
    body: { name, email: `${name.toLowerCase()}${++counter}@example.com`, password: 'password123' },
  });
  if (r.status !== 201) throw new Error(`register failed: ${JSON.stringify(r.json)}`);
  return r.json as unknown as Account;
}

/** Minimal browser-like client: local RGA replica + websocket. */
export class TestClient {
  ws!: WebSocket;
  rga = new Rga();
  seq = 0;
  siteId: string;
  messages: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  private listeners: Array<() => void> = [];

  constructor(
    private wsUrl: string,
    private account: Account,
    private docId: string,
    suffix = 'tab1',
  ) {
    this.siteId = `${account.user.id}~${suffix}`;
  }

  async connect(since?: number): Promise<void> {
    this.ws = new WebSocket(`${this.wsUrl}/ws?token=${this.account.token}`);
    this.ws.on('message', (d) => this.onMessage(JSON.parse(d.toString())));
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
      this.ws.once('unexpected-response', (_req, res) =>
        reject(new Error(`HTTP ${res.statusCode}`)),
      );
    });
    this.send({
      type: 'join',
      docId: this.docId,
      siteId: this.siteId,
      ...(since === undefined ? {} : { since }),
    });
    await this.waitFor((m) => m.type === 'snapshot' || m.type === 'sync' || m.type === 'error');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private onMessage(m: any): void {
    this.messages.push(m);
    if (m.type === 'snapshot') {
      this.rga = Rga.fromJSON(m.state);
      this.seq = m.seq;
    } else if (m.type === 'sync') {
      for (const o of m.ops) this.rga.apply(o.op);
      this.seq = m.seq;
    } else if (m.type === 'ack') {
      this.seq = Math.max(this.seq, m.seq);
    } else if (m.type === 'ops') {
      for (const o of m.ops as Op[]) this.rga.apply(o);
      this.seq = m.seq;
    }
    this.listeners.forEach((l) => l());
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send(msg: any): void {
    this.ws.send(JSON.stringify(msg));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  waitFor(pred: (m: any) => boolean, timeout = 4000): Promise<any> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const m = this.messages.find(pred);
        if (m) {
          this.listeners = this.listeners.filter((l) => l !== check);
          clearTimeout(timer);
          resolve(m);
        }
      };
      const timer = setTimeout(() => {
        this.listeners = this.listeners.filter((l) => l !== check);
        reject(
          new Error(
            'timeout waiting for message; got: ' + JSON.stringify(this.messages.map((x) => x.type)),
          ),
        );
      }, timeout);
      this.listeners.push(check);
      check();
    });
  }

  waitForText(text: string, timeout = 4000): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.rga.text() === text) {
          this.listeners = this.listeners.filter((l) => l !== check);
          clearTimeout(timer);
          resolve();
        }
      };
      const timer = setTimeout(() => {
        this.listeners = this.listeners.filter((l) => l !== check);
        reject(new Error(`timeout: wanted "${text}" but replica is "${this.rga.text()}"`));
      }, timeout);
      this.listeners.push(check);
      check();
    });
  }

  type(index: number, text: string): Promise<void> {
    const ops = this.rga.localInsert(index, text, this.siteId);
    const msgId = `m${this.messages.length}-${Math.random()}`;
    this.send({ type: 'ops', msgId, ops });
    return this.waitFor((m) => m.type === 'ack' && m.msgId === msgId).then(() => undefined);
  }

  remove(index: number, length: number): Promise<void> {
    const ops = this.rga.localDelete(index, length);
    const msgId = `m${this.messages.length}-${Math.random()}`;
    this.send({ type: 'ops', msgId, ops });
    return this.waitFor((m) => m.type === 'ack' && m.msgId === msgId).then(() => undefined);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}
