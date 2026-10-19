import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { RunningServer, startServer } from '../src/server';
import { MemoryStore } from '../src/store/memory';
import { Account, TestClient, api, register } from './helpers/client';

let store: MemoryStore;
let server: RunningServer;
let base: string;
let wsBase: string;
const opened: TestClient[] = [];

async function boot(): Promise<void> {
  server = await startServer({ ...loadConfig({}), port: 0, snapshotEvery: 50 }, store);
  base = `http://127.0.0.1:${server.port}`;
  wsBase = `ws://127.0.0.1:${server.port}`;
}

beforeEach(async () => {
  store = new MemoryStore();
  await boot();
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((c) => c.close().catch(() => undefined)));
  await server.stop();
});

async function connect(
  acc: Account,
  docId: string,
  suffix = 'tab1',
  since?: number,
): Promise<TestClient> {
  const c = new TestClient(wsBase, acc, docId, suffix);
  opened.push(c);
  await c.connect(since);
  return c;
}

async function twoUsersOneDoc() {
  const alice = await register(base, 'Alice');
  const bob = await register(base, 'Bob');
  const created = await api(base, '/api/docs', {
    method: 'POST',
    token: alice.token,
    body: { title: 'Notes' },
  });
  const docId = created.json.document.id as string;
  const share = await api(base, `/api/docs/${docId}/members`, {
    method: 'POST',
    token: alice.token,
    body: { email: bob.user.email, role: 'editor' },
  });
  expect(share.status).toBe(200);
  return { alice, bob, docId };
}

describe('auth and access control', () => {
  it('rejects websocket upgrades without a valid token', async () => {
    const alice = await register(base, 'Alice');
    const doc = (await api(base, '/api/docs', { method: 'POST', token: alice.token, body: {} }))
      .json.document;
    const bad = new TestClient(wsBase, { ...alice, token: 'garbage' }, doc.id);
    await expect(bad.connect()).rejects.toThrow(/401/);
  });

  it('hides documents from non-members (HTTP 404, ws forbidden)', async () => {
    const alice = await register(base, 'Alice');
    const mallory = await register(base, 'Mallory');
    const doc = (
      await api(base, '/api/docs', {
        method: 'POST',
        token: alice.token,
        body: { title: 'Secret' },
      })
    ).json.document;
    expect((await api(base, `/api/docs/${doc.id}`, { token: mallory.token })).status).toBe(404);
    expect((await api(base, `/api/docs/${doc.id}`)).status).toBe(401);
    const c = new TestClient(wsBase, mallory, doc.id);
    opened.push(c);
    await c.connect();
    expect(c.messages.find((m) => m.type === 'error')?.code).toBe('forbidden');
  });

  it('viewers can read but not write', async () => {
    const { alice, bob, docId } = await twoUsersOneDoc();
    await api(base, `/api/docs/${docId}/members`, {
      method: 'POST',
      token: alice.token,
      body: { email: bob.user.email, role: 'viewer' },
    });
    const a = await connect(alice, docId);
    await a.type(0, 'readme');
    const b = await connect(bob, docId);
    expect(b.rga.text()).toBe('readme');
    b.send({ type: 'ops', ops: b.rga.localInsert(0, 'x', b.siteId) });
    await b.waitFor((m) => m.type === 'error' && m.code === 'forbidden');
    const doc = await api(base, `/api/docs/${docId}`, { token: alice.token });
    expect(doc.json.text).toBe('readme');
  });

  it('validates websocket payloads', async () => {
    const { alice, docId } = await twoUsersOneDoc();
    const a = await connect(alice, docId);
    a.send({
      type: 'ops',
      ops: [{ type: 'insert', id: { c: a.siteId, n: 1 }, ref: null, ch: 'too long' }],
    });
    await a.waitFor((m) => m.type === 'error' && m.code === 'bad_message');
    a.send({ type: 'nonsense' });
    await a.waitFor((m) => m.type === 'error' && m.code === 'bad_message' && m !== a.messages[0]);
    // forged site
    const forged = a.rga.planInsert(0, 'x', 'someone-else');
    a.send({ type: 'ops', ops: forged });
    await a.waitFor((m) => m.type === 'error' && m.code === 'bad_message');
  });
});

describe('real-time collaboration', () => {
  it('two clients typing concurrently converge', async () => {
    const { alice, bob, docId } = await twoUsersOneDoc();
    const a = await connect(alice, docId);
    const b = await connect(bob, docId);

    // both type at position 0 at the same moment, before seeing each other's ops
    await Promise.all([a.type(0, 'AAA'), b.type(0, 'BBB')]);
    await Promise.all([a.waitForText(b.rga.text()), b.waitForText(a.rga.text())]);
    expect(a.rga.text()).toHaveLength(6);
    expect(a.rga.text()).toBe(b.rga.text());

    // concurrent delete + insert
    const t = a.rga.text();
    await Promise.all([a.remove(0, 2), b.type(t.length, '!')]);
    await new Promise((r) => setTimeout(r, 100));
    await Promise.all([a.waitForText(b.rga.text()), b.waitForText(a.rga.text())]);
    expect(a.rga.text()).toBe(b.rga.text());
    expect(a.rga.text().endsWith('!')).toBe(true);
    expect(a.rga.text()).toHaveLength(5);
  });

  it('a late joiner receives the current document', async () => {
    const { alice, bob, docId } = await twoUsersOneDoc();
    const a = await connect(alice, docId);
    await a.type(0, 'already here');
    const b = await connect(bob, docId);
    expect(b.rga.text()).toBe('already here');
  });

  it('broadcasts cursor presence (anchored to element ids) and leave events', async () => {
    const { alice, bob, docId } = await twoUsersOneDoc();
    const a = await connect(alice, docId);
    const b = await connect(bob, docId);
    await a.type(0, 'abc');
    const anchor = a.rga.idAtVisible(1);
    a.send({ type: 'presence', cursor: { anchor, head: anchor } });
    const p = await b.waitFor((m) => m.type === 'presence');
    expect(p.siteId).toBe(a.siteId);
    expect(p.name).toBe('Alice');
    expect(p.cursor.anchor).toEqual(anchor);
    expect(p.color).toMatch(/^#/);
    // presence must not appear in the durable log
    expect(await store.getHeadSeq(docId)).toBe(3);
    await a.close();
    await b.waitFor((m) => m.type === 'presence_leave' && m.siteId === a.siteId);
  });

  it('undo/redo over the wire only touches your own edits', async () => {
    const { alice, bob, docId } = await twoUsersOneDoc();
    const a = await connect(alice, docId);
    const b = await connect(bob, docId);
    await a.type(0, 'Alice');
    await b.waitForText('Alice');
    await b.type(5, ' & Bob');
    await a.waitForText('Alice & Bob');
    a.send({ type: 'undo' });
    await Promise.all([a.waitForText(' & Bob'), b.waitForText(' & Bob')]);
    a.send({ type: 'redo' });
    await Promise.all([a.waitForText('Alice & Bob'), b.waitForText('Alice & Bob')]);
  });
});

describe('reconnect, recovery and history', () => {
  it('a reconnecting client catches up using `since`', async () => {
    const { alice, bob, docId } = await twoUsersOneDoc();
    const a = await connect(alice, docId);
    const b = await connect(bob, docId);
    await a.type(0, 'hello');
    await b.waitForText('hello');
    const lastSeq = b.seq;
    await b.close();
    await a.type(5, ' world'); // happens while bob is offline
    const b2 = new TestClient(wsBase, bob, docId, 'tab1'); // same siteId, keeps its replica
    b2.rga = b.rga;
    opened.push(b2);
    await b2.connect(lastSeq);
    expect(b2.messages.some((m) => m.type === 'sync')).toBe(true);
    expect(b2.rga.text()).toBe('hello world');
  });

  it('survives a server restart (snapshot + op log replay) with the same data', async () => {
    const { alice, docId } = await twoUsersOneDoc();
    const a = await connect(alice, docId);
    await a.type(0, 'persist me ');
    await a.type(11, 'please');
    await a.remove(0, 8);
    const expected = a.rga.text();
    await a.close();
    await server.stop();

    await boot(); // same store, new process-equivalent
    const doc = await api(base, `/api/docs/${docId}`, { token: alice.token });
    expect(doc.status).toBe(200);
    expect(doc.json.text).toBe(expected);
    const a2 = await connect(alice, docId);
    expect(a2.rga.text()).toBe(expected);
  });

  it('lists versions, time-travels, compares and restores without losing history', async () => {
    const { alice, docId } = await twoUsersOneDoc();
    const a = await connect(alice, docId);
    await a.type(0, 'line one');
    const v1 = a.seq;
    await a.type(8, '\nline two');
    const v2 = a.seq;
    await a.remove(0, 4);
    await a.type(0, 'LINE');
    const head = a.seq;

    const t = (seq: number) =>
      api(base, `/api/docs/${docId}/versions/${seq}`, { token: alice.token });
    expect((await t(v1)).json.text).toBe('line one');
    expect((await t(v2)).json.text).toBe('line one\nline two');
    expect((await t(0)).json.text).toBe('');

    const cmp = await api(base, `/api/docs/${docId}/compare?from=${v2}&to=${head}`, {
      token: alice.token,
    });
    expect(cmp.json.to.text).toBe('LINE one\nline two');
    expect(cmp.json.diff.some((d: { type: string }) => d.type === 'add')).toBe(true);

    const restore = await api(base, `/api/docs/${docId}/versions/${v1}/restore`, {
      method: 'POST',
      token: alice.token,
    });
    expect(restore.status).toBe(200);
    await a.waitForText('line one');
    // history before the restore is still reachable
    expect((await t(head)).json.text).toBe('LINE one\nline two');
    const versions = await api(base, `/api/docs/${docId}/versions`, { token: alice.token });
    expect(versions.json.head).toBeGreaterThan(head);
  });

  it('renames documents and notifies connected clients', async () => {
    const { alice, docId } = await twoUsersOneDoc();
    const a = await connect(alice, docId);
    const r = await api(base, `/api/docs/${docId}`, {
      method: 'PATCH',
      token: alice.token,
      body: { title: 'Renamed' },
    });
    expect(r.status).toBe(200);
    await a.waitFor((m) => m.type === 'meta' && m.title === 'Renamed');
    const list = await api(base, '/api/docs', { token: alice.token });
    expect(list.json.documents[0].title).toBe('Renamed');
  });
});
