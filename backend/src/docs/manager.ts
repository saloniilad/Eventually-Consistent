import { log } from '../util/logger';
import type { Store } from '../store/types';
import { DocumentSession, SessionOptions } from './session';

interface Entry {
  refs: number;
  promise: Promise<DocumentSession>;
}

/**
 * Reference-counted registry of live sessions. A session is loaded on first acquire
 * and snapshotted + evicted when the last holder releases it.
 */
export class SessionManager {
  private entries = new Map<string, Entry>();

  constructor(
    private store: Store,
    private opts: SessionOptions,
  ) {}

  async acquire(docId: string): Promise<DocumentSession> {
    let e = this.entries.get(docId);
    if (!e) {
      const entry: Entry = { refs: 0, promise: DocumentSession.load(this.store, docId, this.opts) };
      entry.promise.catch(() => {
        if (this.entries.get(docId) === entry) this.entries.delete(docId);
      });
      this.entries.set(docId, entry);
      e = entry;
    }
    e.refs++; // synchronous with lookup: prevents eviction racing with a join
    try {
      return await e.promise;
    } catch (err) {
      e.refs--;
      throw err;
    }
  }

  async release(docId: string): Promise<void> {
    const e = this.entries.get(docId);
    if (!e) return;
    e.refs--;
    if (e.refs > 0) return;
    try {
      await (await e.promise).flush();
    } catch (err) {
      log.error('snapshot on release failed', { docId, err: String(err) });
    }
    if (e.refs === 0 && this.entries.get(docId) === e) this.entries.delete(docId);
  }

  /** Live session if one is loaded (does not take a reference). */
  peek(docId: string): Promise<DocumentSession> | undefined {
    return this.entries.get(docId)?.promise;
  }

  async closeAll(): Promise<void> {
    const all = [...this.entries.values()];
    await Promise.all(
      all.map(async (e) => {
        try {
          await (await e.promise).flush();
        } catch (err) {
          log.error('flush failed', { err: String(err) });
        }
      }),
    );
    this.entries.clear();
  }
}
