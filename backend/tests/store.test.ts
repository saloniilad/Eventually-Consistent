import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Rga } from '../src/crdt/rga';
import { SessionManager } from '../src/docs/manager';
import { MemoryStore } from '../src/store/memory';
import { PostgresStore } from '../src/store/postgres';
import { DuplicateError, Store } from '../src/store/types';

const pgUrl = process.env.TEST_DATABASE_URL;

/** The same contract suite runs against the in-memory store and (when configured) real PostgreSQL. */
function contract(name: string, make: () => Store, skip = false) {
  describe.skipIf(skip)(`Store contract: ${name}`, () => {
    let store: Store;
    beforeAll(async () => {
      store = make();
      await store.init();
      await store.init(); // schema must be idempotent
    });
    afterAll(async () => {
      await store.close();
    });

    it('users: unique case-insensitive email', async () => {
      const email = `U${Math.random()}@Example.com`;
      const u = await store.createUser({ email, name: 'U', passwordHash: 'h' });
      expect(u.email).toBe(email.toLowerCase());
      await expect(
        store.createUser({ email: email.toUpperCase(), name: 'V', passwordHash: 'h' }),
      ).rejects.toBeInstanceOf(DuplicateError);
      expect((await store.findUserByEmail(email))?.id).toBe(u.id);
      expect((await store.findUserById(u.id))?.name).toBe('U');
    });

    it('documents, roles and listing', async () => {
      const o = await store.createUser({
        email: `o${Math.random()}@x.io`,
        name: 'O',
        passwordHash: 'h',
      });
      const e = await store.createUser({
        email: `e${Math.random()}@x.io`,
        name: 'E',
        passwordHash: 'h',
      });
      const d = await store.createDocument(o.id, 'T');
      expect(await store.getRole(d.id, o.id)).toBe('owner');
      expect(await store.getRole(d.id, e.id)).toBeNull();
      await store.setMember(d.id, e.id, 'viewer');
      await store.setMember(d.id, e.id, 'editor');
      expect(await store.getRole(d.id, e.id)).toBe('editor');
      await store.renameDocument(d.id, 'T2');
      expect((await store.listDocuments(e.id)).map((x) => [x.title, x.role])).toEqual([
        ['T2', 'editor'],
      ]);
    });

    it('operation log: ordered seq, duplicate ops are ignored, range queries', async () => {
      const u = await store.createUser({
        email: `l${Math.random()}@x.io`,
        name: 'L',
        passwordHash: 'h',
      });
      const d = await store.createDocument(u.id, 'Log');
      const ops = new Rga().localInsert(0, 'abc', `${u.id}~s`);
      const mk = (op: (typeof ops)[number]) => ({
        opId: `i:${op.id.c}:${op.id.n}`,
        userId: u.id,
        siteId: op.id.c,
        op,
      });
      const first = await store.appendOps(d.id, ops.map(mk));
      expect(first).toHaveLength(3);
      expect(first[0].seq).toBeLessThan(first[1].seq);
      const again = await store.appendOps(d.id, ops.map(mk));
      expect(again).toHaveLength(0); // retry / duplicate delivery
      const mixed = await store.appendOps(d.id, [
        mk(ops[0]),
        mk(new Rga().localInsert(0, 'z', `${u.id}~t`)[0]),
      ]);
      expect(mixed).toHaveLength(1);
      const all = await store.getOpsAfter(d.id, 0);
      expect(all).toHaveLength(4);
      expect(await store.getHeadSeq(d.id)).toBe(all[3].seq);
      expect((await store.getOpsAfter(d.id, all[0].seq, all[2].seq)).map((r) => r.seq)).toEqual([
        all[1].seq,
        all[2].seq,
      ]);
      expect(all[0].op).toEqual(ops[0]); // JSON round trip is lossless
      expect(await store.getHeadSeq((await store.createDocument(u.id, 'Empty')).id)).toBe(0);
    });

    it('snapshots: latest and at-or-before', async () => {
      const u = await store.createUser({
        email: `s${Math.random()}@x.io`,
        name: 'S',
        passwordHash: 'h',
      });
      const d = await store.createDocument(u.id, 'Snap');
      const r = new Rga();
      r.localInsert(0, 'hi', 'a');
      await store.saveSnapshot(d.id, 10, r.toJSON());
      r.localInsert(2, '!', 'a');
      await store.saveSnapshot(d.id, 20, r.toJSON());
      await store.saveSnapshot(d.id, 20, r.toJSON()); // idempotent
      expect((await store.listSnapshots(d.id)).map((s) => s.seq)).toEqual([10, 20]);
      expect((await store.getLatestSnapshot(d.id))?.seq).toBe(20);
      expect((await store.getSnapshotAtOrBefore(d.id, 15))?.seq).toBe(10);
      expect(await store.getSnapshotAtOrBefore(d.id, 5)).toBeNull();
      expect(Rga.fromJSON((await store.getLatestSnapshot(d.id))!.state).text()).toBe('hi!');
    });

    it('end to end: session writes, a fresh manager recovers', async () => {
      const u = await store.createUser({
        email: `r${Math.random()}@x.io`,
        name: 'R',
        passwordHash: 'h',
      });
      const d = await store.createDocument(u.id, 'Recover');
      const opts = { snapshotEvery: 5, maxDocChars: 1000 };
      const s1 = await new SessionManager(store, opts).acquire(d.id);
      const conn = {
        id: '1',
        userId: u.id,
        name: 'R',
        siteId: `${u.id}~a`,
        role: 'owner' as const,
        send: () => undefined,
      };
      await s1.join(conn);
      const local = new Rga();
      await s1.submit(conn, local.localInsert(0, 'durable text', conn.siteId));
      await s1.submit(conn, local.localDelete(0, 8));
      const s2 = await new SessionManager(store, opts).acquire(d.id);
      expect(s2.text).toBe('text');
      expect(s2.headSeq).toBe(s1.headSeq);
    });
  });
}

contract('memory', () => new MemoryStore());
contract('postgres', () => new PostgresStore(pgUrl as string), !pgUrl);
