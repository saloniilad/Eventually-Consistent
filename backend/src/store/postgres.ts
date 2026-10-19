import { Pool, types } from 'pg';
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
import type { Op, RgaSnapshot } from '../crdt/rga';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// BIGINT (oid 20) comes back as a string by default; our seq values fit in a JS number.
types.setTypeParser(20, (v: string) => Number(v));

interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  created_at: Date;
}
interface DocRow {
  id: string;
  title: string;
  owner_id: string;
  created_at: Date;
  updated_at: Date;
}

const toUser = (r: UserRow): User => ({
  id: r.id,
  email: r.email,
  name: r.name,
  passwordHash: r.password_hash,
  createdAt: r.created_at,
});
const toDoc = (r: DocRow): DocMeta => ({
  id: r.id,
  title: r.title,
  ownerId: r.owner_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class PostgresStore implements Store {
  readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10 });
  }

  async init(): Promise<void> {
    const sql = readFileSync(join(__dirname, '..', '..', 'db', 'schema.sql'), 'utf8');
    await this.pool.query(sql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createUser(u: { email: string; name: string; passwordHash: string }): Promise<User> {
    try {
      const r = await this.pool.query<UserRow>(
        'INSERT INTO users (email, name, password_hash) VALUES (lower($1), $2, $3) RETURNING *',
        [u.email, u.name, u.passwordHash],
      );
      return toUser(r.rows[0]);
    } catch (err) {
      if ((err as { code?: string }).code === '23505')
        throw new DuplicateError('email already registered');
      throw err;
    }
  }

  async findUserByEmail(email: string): Promise<User | null> {
    const r = await this.pool.query<UserRow>('SELECT * FROM users WHERE email = lower($1)', [
      email,
    ]);
    return r.rows[0] ? toUser(r.rows[0]) : null;
  }

  async findUserById(id: string): Promise<User | null> {
    const r = await this.pool.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
    return r.rows[0] ? toUser(r.rows[0]) : null;
  }

  async createDocument(ownerId: string, title: string): Promise<DocMeta> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query<DocRow>(
        'INSERT INTO documents (title, owner_id) VALUES ($1, $2) RETURNING *',
        [title, ownerId],
      );
      await client.query(
        "INSERT INTO document_members (doc_id, user_id, role) VALUES ($1, $2, 'owner')",
        [r.rows[0].id, ownerId],
      );
      await client.query('COMMIT');
      return toDoc(r.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getDocument(id: string): Promise<DocMeta | null> {
    const r = await this.pool.query<DocRow>('SELECT * FROM documents WHERE id = $1', [id]);
    return r.rows[0] ? toDoc(r.rows[0]) : null;
  }

  async listDocuments(userId: string): Promise<Array<DocMeta & { role: Role }>> {
    const r = await this.pool.query<DocRow & { role: Role }>(
      `SELECT d.*, m.role FROM documents d
         JOIN document_members m ON m.doc_id = d.id
        WHERE m.user_id = $1 ORDER BY d.updated_at DESC`,
      [userId],
    );
    return r.rows.map((row) => ({ ...toDoc(row), role: row.role }));
  }

  async renameDocument(id: string, title: string): Promise<void> {
    await this.pool.query('UPDATE documents SET title = $2, updated_at = now() WHERE id = $1', [
      id,
      title,
    ]);
  }

  async getRole(docId: string, userId: string): Promise<Role | null> {
    const r = await this.pool.query<{ role: Role }>(
      'SELECT role FROM document_members WHERE doc_id = $1 AND user_id = $2',
      [docId, userId],
    );
    return r.rows[0]?.role ?? null;
  }

  async setMember(docId: string, userId: string, role: Role): Promise<void> {
    await this.pool.query(
      `INSERT INTO document_members (doc_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (doc_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [docId, userId, role],
    );
  }

  async appendOps(docId: string, ops: NewOp[]): Promise<OpRecord[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out: OpRecord[] = [];
      for (const o of ops) {
        const r = await client.query<{ seq: number; created_at: Date }>(
          `INSERT INTO operations (doc_id, op_id, user_id, site_id, op)
           VALUES ($1, $2, $3, $4, $5::jsonb)
           ON CONFLICT (doc_id, op_id) DO NOTHING
           RETURNING seq, created_at`,
          [docId, o.opId, o.userId, o.siteId, JSON.stringify(o.op)],
        );
        if (r.rowCount) out.push({ ...o, seq: r.rows[0].seq, createdAt: r.rows[0].created_at });
      }
      if (out.length)
        await client.query('UPDATE documents SET updated_at = now() WHERE id = $1', [docId]);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getOpsAfter(
    docId: string,
    afterSeq: number,
    uptoSeq?: number,
    limit = 5000,
  ): Promise<OpRecord[]> {
    const r = await this.pool.query<{
      seq: number;
      op_id: string;
      user_id: string;
      site_id: string;
      op: Op;
      created_at: Date;
    }>(
      `SELECT seq, op_id, user_id, site_id, op, created_at FROM operations
        WHERE doc_id = $1 AND seq > $2 AND ($3::bigint IS NULL OR seq <= $3)
        ORDER BY seq LIMIT $4`,
      [docId, afterSeq, uptoSeq ?? null, limit],
    );
    return r.rows.map((x) => ({
      seq: x.seq,
      opId: x.op_id,
      userId: x.user_id,
      siteId: x.site_id,
      op: x.op,
      createdAt: x.created_at,
    }));
  }

  async getHeadSeq(docId: string): Promise<number> {
    const r = await this.pool.query<{ head: number | null }>(
      'SELECT max(seq) AS head FROM operations WHERE doc_id = $1',
      [docId],
    );
    return r.rows[0]?.head ?? 0;
  }

  async saveSnapshot(docId: string, seq: number, state: RgaSnapshot): Promise<void> {
    await this.pool.query(
      `INSERT INTO snapshots (doc_id, seq, state) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (doc_id, seq) DO NOTHING`,
      [docId, seq, JSON.stringify(state)],
    );
  }

  async getLatestSnapshot(docId: string): Promise<SnapshotRecord | null> {
    const r = await this.pool.query<{ seq: number; state: RgaSnapshot; created_at: Date }>(
      'SELECT seq, state, created_at FROM snapshots WHERE doc_id = $1 ORDER BY seq DESC LIMIT 1',
      [docId],
    );
    return r.rows[0]
      ? { seq: r.rows[0].seq, state: r.rows[0].state, createdAt: r.rows[0].created_at }
      : null;
  }

  async getSnapshotAtOrBefore(docId: string, seq: number): Promise<SnapshotRecord | null> {
    const r = await this.pool.query<{ seq: number; state: RgaSnapshot; created_at: Date }>(
      'SELECT seq, state, created_at FROM snapshots WHERE doc_id = $1 AND seq <= $2 ORDER BY seq DESC LIMIT 1',
      [docId, seq],
    );
    return r.rows[0]
      ? { seq: r.rows[0].seq, state: r.rows[0].state, createdAt: r.rows[0].created_at }
      : null;
  }

  async listSnapshots(docId: string): Promise<Array<{ seq: number; createdAt: Date }>> {
    const r = await this.pool.query<{ seq: number; created_at: Date }>(
      'SELECT seq, created_at FROM snapshots WHERE doc_id = $1 ORDER BY seq',
      [docId],
    );
    return r.rows.map((x) => ({ seq: x.seq, createdAt: x.created_at }));
  }
}
