import type { Op, RgaSnapshot } from '../crdt/rga';

export type Role = 'owner' | 'editor' | 'viewer';
export const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export interface User {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  createdAt: Date;
}

export interface DocMeta {
  id: string;
  title: string;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewOp {
  opId: string;
  userId: string;
  siteId: string;
  op: Op;
}

export interface OpRecord extends NewOp {
  seq: number;
  createdAt: Date;
}

export interface SnapshotRecord {
  seq: number;
  state: RgaSnapshot;
  createdAt: Date;
}

export class DuplicateError extends Error {}

export interface Store {
  init(): Promise<void>;
  close(): Promise<void>;

  createUser(u: { email: string; name: string; passwordHash: string }): Promise<User>;
  findUserByEmail(email: string): Promise<User | null>;
  findUserById(id: string): Promise<User | null>;

  createDocument(ownerId: string, title: string): Promise<DocMeta>;
  getDocument(id: string): Promise<DocMeta | null>;
  listDocuments(userId: string): Promise<Array<DocMeta & { role: Role }>>;
  renameDocument(id: string, title: string): Promise<void>;
  getRole(docId: string, userId: string): Promise<Role | null>;
  setMember(docId: string, userId: string, role: Role): Promise<void>;

  /** Atomically append ops. Returns records only for ops that were NOT already in the log. */
  appendOps(docId: string, ops: NewOp[]): Promise<OpRecord[]>;
  getOpsAfter(
    docId: string,
    afterSeq: number,
    uptoSeq?: number,
    limit?: number,
  ): Promise<OpRecord[]>;
  getHeadSeq(docId: string): Promise<number>;

  saveSnapshot(docId: string, seq: number, state: RgaSnapshot): Promise<void>;
  getLatestSnapshot(docId: string): Promise<SnapshotRecord | null>;
  getSnapshotAtOrBefore(docId: string, seq: number): Promise<SnapshotRecord | null>;
  listSnapshots(docId: string): Promise<Array<{ seq: number; createdAt: Date }>>;
}
