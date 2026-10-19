import { randomUUID } from 'node:crypto';
import {
  DocMeta,
  DuplicateError,
  NewOp,
  OpRecord,
  Role,
  SnapshotRecord,
  Store,
  User,
} from './types';
import type { RgaSnapshot } from '../crdt/rga';

/** In-memory Store for tests and quick local runs. Data is lost when the process exits. */
export class MemoryStore implements Store {
  private users = new Map<string, User>();
  private docs = new Map<string, DocMeta>();
  private members = new Map<string, Role>(); // `${docId}|${userId}`
  private ops = new Map<string, OpRecord[]>();
  private opIds = new Map<string, Set<string>>();
  private snaps = new Map<string, SnapshotRecord[]>();
  private seqCounter = 0;

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  async createUser(u: { email: string; name: string; passwordHash: string }): Promise<User> {
    const email = u.email.toLowerCase();
    if ([...this.users.values()].some((x) => x.email === email)) {
      throw new DuplicateError('email already registered');
    }
    const user: User = {
      id: randomUUID(),
      email,
      name: u.name,
      passwordHash: u.passwordHash,
      createdAt: new Date(),
    };
    this.users.set(user.id, user);
    return user;
  }

  async findUserByEmail(email: string): Promise<User | null> {
    const e = email.toLowerCase();
    return [...this.users.values()].find((u) => u.email === e) ?? null;
  }

  async findUserById(id: string): Promise<User | null> {
    return this.users.get(id) ?? null;
  }

  async createDocument(ownerId: string, title: string): Promise<DocMeta> {
    const now = new Date();
    const doc: DocMeta = { id: randomUUID(), title, ownerId, createdAt: now, updatedAt: now };
    this.docs.set(doc.id, doc);
    this.members.set(`${doc.id}|${ownerId}`, 'owner');
    return doc;
  }

  async getDocument(id: string): Promise<DocMeta | null> {
    return this.docs.get(id) ?? null;
  }

  async listDocuments(userId: string): Promise<Array<DocMeta & { role: Role }>> {
    const out: Array<DocMeta & { role: Role }> = [];
    for (const [k, role] of this.members) {
      const [docId, uid] = k.split('|');
      const doc = this.docs.get(docId);
      if (uid === userId && doc) out.push({ ...doc, role });
    }
    return out.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  async renameDocument(id: string, title: string): Promise<void> {
    const d = this.docs.get(id);
    if (d) {
      d.title = title;
      d.updatedAt = new Date();
    }
  }

  async getRole(docId: string, userId: string): Promise<Role | null> {
    return this.members.get(`${docId}|${userId}`) ?? null;
  }

  async setMember(docId: string, userId: string, role: Role): Promise<void> {
    this.members.set(`${docId}|${userId}`, role);
  }

  async appendOps(docId: string, ops: NewOp[]): Promise<OpRecord[]> {
    const log = this.ops.get(docId) ?? [];
    const seen = this.opIds.get(docId) ?? new Set<string>();
    const out: OpRecord[] = [];
    for (const o of ops) {
      if (seen.has(o.opId)) continue;
      seen.add(o.opId);
      const rec: OpRecord = { ...o, seq: ++this.seqCounter, createdAt: new Date() };
      log.push(rec);
      out.push(rec);
    }
    this.ops.set(docId, log);
    this.opIds.set(docId, seen);
    const d = this.docs.get(docId);
    if (d && out.length) d.updatedAt = new Date();
    return out;
  }

  async getOpsAfter(
    docId: string,
    afterSeq: number,
    uptoSeq?: number,
    limit = 5000,
  ): Promise<OpRecord[]> {
    const log = this.ops.get(docId) ?? [];
    return log
      .filter((o) => o.seq > afterSeq && (uptoSeq === undefined || o.seq <= uptoSeq))
      .slice(0, limit);
  }

  async getHeadSeq(docId: string): Promise<number> {
    const log = this.ops.get(docId) ?? [];
    return log.length ? log[log.length - 1].seq : 0;
  }

  async saveSnapshot(docId: string, seq: number, state: RgaSnapshot): Promise<void> {
    const list = this.snaps.get(docId) ?? [];
    if (list.some((s) => s.seq === seq)) return;
    // structuredClone: a stored snapshot must never alias live replica state.
    list.push({ seq, state: structuredClone(state), createdAt: new Date() });
    list.sort((a, b) => a.seq - b.seq);
    this.snaps.set(docId, list);
  }

  async getLatestSnapshot(docId: string): Promise<SnapshotRecord | null> {
    const list = this.snaps.get(docId) ?? [];
    return list.length ? list[list.length - 1] : null;
  }

  async getSnapshotAtOrBefore(docId: string, seq: number): Promise<SnapshotRecord | null> {
    const list = (this.snaps.get(docId) ?? []).filter((s) => s.seq <= seq);
    return list.length ? list[list.length - 1] : null;
  }

  async listSnapshots(docId: string): Promise<Array<{ seq: number; createdAt: Date }>> {
    return (this.snaps.get(docId) ?? []).map(({ seq, createdAt }) => ({ seq, createdAt }));
  }
}
