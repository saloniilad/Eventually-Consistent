import { describe, expect, it } from 'vitest';
import { Rga } from '../src/crdt/rga';
import { SessionManager } from '../src/docs/manager';
import { rebuild } from '../src/docs/replay';
import { ClientConn, ProtocolError } from '../src/docs/session';
import { MemoryStore } from '../src/store/memory';
import type { Role } from '../src/store/types';
import type { ServerMessage } from '../src/ws/protocol';

async function setup(snapshotEvery = 1000) {
  const store = new MemoryStore();
  const alice = await store.createUser({ email: 'a@x.io', name: 'Alice', passwordHash: 'x' });
  const bob = await store.createUser({ email: 'b@x.io', name: 'Bob', passwordHash: 'x' });
  const doc = await store.createDocument(alice.id, 'Doc');
  await store.setMember(doc.id, bob.id, 'editor');
  const opts = { snapshotEvery, maxDocChars: 1000 };
  const sessions = new SessionManager(store, opts);
  return { store, alice, bob, doc, sessions, opts };
}

function conn(user: { id: string; name: string }, suffix: string, role: Role = 'editor') {
  const inbox: ServerMessage[] = [];
  const c: ClientConn = {
    id: `${user.id}-${suffix}`,
    userId: user.id,
    name: user.name,
    siteId: `${user.id}~${suffix}`,
    role,
    send: (m) => void inbox.push(m),
  };
  return { c, inbox, replica: new Rga() };
}

describe('document session', () => {
  it('persists ops, broadcasts to others, and acks the sender', async () => {
    const { sessions, alice, bob, doc } = await setup();
    const s = await sessions.acquire(doc.id);
    const A = conn(alice, 'a');
    const B = conn(bob, 'b');
    await s.join(A.c);
    await s.join(B.c);
    const ops = A.replica.localInsert(0, 'hi', A.c.siteId);
    await s.submit(A.c, ops, 'm1');
    expect(s.text).toBe('hi');
    expect(A.inbox.some((m) => m.type === 'ack' && m.msgId === 'm1')).toBe(true);
    expect(B.inbox.some((m) => m.type === 'ops')).toBe(true);
    expect(A.inbox.some((m) => m.type === 'ops')).toBe(false); // no echo
  });

  it('is idempotent for duplicate/retried batches', async () => {
    const { sessions, alice, doc, store } = await setup();
    const s = await sessions.acquire(doc.id);
    const A = conn(alice, 'a');
    await s.join(A.c);
    const ops = A.replica.localInsert(0, 'dup', A.c.siteId);
    await s.submit(A.c, ops);
    await s.submit(A.c, ops);
    await s.submit(A.c, ops);
    expect(s.text).toBe('dup');
    expect((await store.getOpsAfter(doc.id, 0)).length).toBe(3);
  });

  it('rejects forged site ids, unknown dependencies and viewer writes', async () => {
    const { sessions, alice, bob, doc } = await setup();
    const s = await sessions.acquire(doc.id);
    const A = conn(alice, 'a');
    const V = conn(bob, 'v', 'viewer');
    await s.join(A.c);
    await s.join(V.c);

    const forged = new Rga().localInsert(0, 'x', `${bob.id}~evil`);
    await expect(s.submit(A.c, forged)).rejects.toMatchObject({ code: 'bad_site' });

    const orphan = new Rga();
    orphan.localInsert(0, 'ab', A.c.siteId);
    const lone = orphan.planInsert(2, 'c', A.c.siteId);
    await expect(s.submit(A.c, lone)).rejects.toBeInstanceOf(ProtocolError);

    const mine = new Rga().localInsert(0, 'z', V.c.siteId);
    await expect(s.submit(V.c, mine)).rejects.toMatchObject({ code: 'forbidden' });
    expect(s.text).toBe('');
  });

  it('enforces the document size cap', async () => {
    const { sessions, alice, doc } = await setup();
    const s = await sessions.acquire(doc.id);
    const A = conn(alice, 'a');
    await s.join(A.c);
    const big = new Rga().localInsert(0, 'x'.repeat(1001), A.c.siteId);
    await expect(s.submit(A.c, big)).rejects.toMatchObject({ code: 'doc_too_large' });
  });

  it('undo/redo only affects the requesting user, and is broadcast as normal ops', async () => {
    const { sessions, alice, bob, doc } = await setup();
    const s = await sessions.acquire(doc.id);
    const A = conn(alice, 'a');
    const B = conn(bob, 'b');
    await s.join(A.c);
    await s.join(B.c);
    await s.submit(A.c, A.replica.localInsert(0, 'Alice ', A.c.siteId));
    // Bob builds his replica from what the server broadcast, then appends after Alice's text
    const bobOps = new Rga();
    for (const m of B.inbox) if (m.type === 'ops') m.ops.forEach((o) => bobOps.apply(o));
    await s.submit(B.c, bobOps.localInsert(6, 'Bob', B.c.siteId));
    expect(s.text).toBe('Alice Bob');
    await s.undoRedo(A.c, 'undo');
    expect(s.text).toBe('Bob');
    await s.undoRedo(A.c, 'redo');
    expect(s.text).toBe('Alice Bob');
    await s.undoRedo(B.c, 'undo');
    expect(s.text).toBe('Alice ');
  });

  it('keeps presence out of the durable log', async () => {
    const { sessions, alice, bob, doc, store } = await setup();
    const s = await sessions.acquire(doc.id);
    const A = conn(alice, 'a');
    const B = conn(bob, 'b');
    await s.join(A.c);
    await s.join(B.c);
    s.setPresence(A.c, { anchor: null, head: null });
    expect(B.inbox.some((m) => m.type === 'presence')).toBe(true);
    expect(await store.getHeadSeq(doc.id)).toBe(0);
    s.leave(A.c);
    expect(B.inbox.some((m) => m.type === 'presence_leave')).toBe(true);
  });
});

describe('persistence and recovery', () => {
  it('recovers a document after a "server restart" from snapshot + replayed ops', async () => {
    const { store, alice, doc, sessions, opts } = await setup(10); // snapshot every 10 ops
    const s = await sessions.acquire(doc.id);
    const A = conn(alice, 'a');
    await s.join(A.c);
    await s.submit(A.c, A.replica.localInsert(0, 'the quick brown fox', A.c.siteId)); // 19 ops -> snapshot
    await s.submit(A.c, A.replica.localDelete(4, 6)); // 6 more ops after the snapshot
    const expected = s.text;
    expect(expected).toBe('the brown fox');
    expect((await store.listSnapshots(doc.id)).length).toBeGreaterThanOrEqual(1);

    // brand-new manager over the same store == process restart
    const restarted = new SessionManager(store, opts);
    const s2 = await restarted.acquire(doc.id);
    expect(s2.text).toBe(expected);
    expect(s2.headSeq).toBe(s.headSeq);

    // and the recovered replica keeps accepting edits from the original site/counter
    const A2 = conn(alice, 'a');
    await s2.join(A2.c);
    const fresh = Rga.fromJSON(s['rga'].toJSON());
    await s2.submit(A2.c, fresh.localInsert(0, '>> ', A2.c.siteId));
    expect(s2.text).toBe('>> the brown fox');
  });

  it('recovers from the op log alone when no snapshot exists', async () => {
    const { store, alice, doc, sessions } = await setup(100000);
    const s = await sessions.acquire(doc.id);
    const A = conn(alice, 'a');
    await s.join(A.c);
    await s.submit(A.c, A.replica.localInsert(0, 'log only', A.c.siteId));
    expect(await store.listSnapshots(doc.id)).toHaveLength(0);
    const { rga } = await rebuild(store, doc.id);
    expect(rga.text()).toBe('log only');
  });

  it('writes a snapshot when the last client leaves', async () => {
    const { store, alice, doc, sessions } = await setup(100000);
    const s = await sessions.acquire(doc.id);
    const A = conn(alice, 'a');
    await s.join(A.c);
    await s.submit(A.c, A.replica.localInsert(0, 'bye', A.c.siteId));
    s.leave(A.c);
    await sessions.release(doc.id);
    expect((await store.listSnapshots(doc.id)).length).toBe(1);
  });

  it('reconnect with `since` receives only the missed ops', async () => {
    const { sessions, alice, bob, doc } = await setup();
    const s = await sessions.acquire(doc.id);
    const A = conn(alice, 'a');
    await s.join(A.c);
    await s.submit(A.c, A.replica.localInsert(0, 'one ', A.c.siteId));
    const seqSeen = s.headSeq;
    const B = conn(bob, 'b');
    await s.join(B.c);
    await s.submit(A.c, A.replica.localInsert(4, 'two', A.c.siteId));
    const B2 = conn(bob, 'b2');
    await s.join(B2.c, seqSeen);
    const sync = B2.inbox.find((m) => m.type === 'sync');
    expect(sync && sync.type === 'sync' && sync.ops.length).toBe(3); // only "two"
  });

  it('time travel: rebuilds historical states and restore is a new forward edit', async () => {
    const { store, alice, doc, sessions } = await setup(5);
    const s = await sessions.acquire(doc.id);
    const A = conn(alice, 'a');
    await s.join(A.c);
    await s.submit(A.c, A.replica.localInsert(0, 'version one', A.c.siteId));
    const v1 = s.headSeq;
    await s.submit(A.c, A.replica.localDelete(8, 3));
    await s.submit(A.c, A.replica.localInsert(8, 'two', A.c.siteId));
    expect(s.text).toBe('version two');
    expect((await rebuild(store, doc.id, v1)).rga.text()).toBe('version one');
    expect((await rebuild(store, doc.id, 0)).rga.text()).toBe('');

    const headBefore = s.headSeq;
    await s.replaceText(alice.id, 'version one');
    expect(s.text).toBe('version one');
    expect(s.headSeq).toBeGreaterThan(headBefore); // history only moves forward
    expect((await rebuild(store, doc.id, headBefore)).rga.text()).toBe('version two');
  });
});
