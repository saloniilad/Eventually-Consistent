import { Rga } from '../crdt/rga';
import type { Store } from '../store/types';

const PAGE = 5000;

/**
 * Rebuild a document: newest snapshot at or before `uptoSeq` (or newest overall),
 * then replay every later operation. Used on session start, restart recovery, and
 * historical "time travel".
 */
export async function rebuild(
  store: Store,
  docId: string,
  uptoSeq?: number,
): Promise<{ rga: Rga; seq: number; snapshotSeq: number; replayed: number }> {
  const snap =
    uptoSeq === undefined
      ? await store.getLatestSnapshot(docId)
      : await store.getSnapshotAtOrBefore(docId, uptoSeq);
  const rga = snap ? Rga.fromJSON(snap.state) : new Rga();
  let seq = snap?.seq ?? 0;
  const snapshotSeq = seq;
  let replayed = 0;
  for (;;) {
    const page = await store.getOpsAfter(docId, seq, uptoSeq, PAGE);
    for (const rec of page) {
      rga.apply(rec.op);
      seq = rec.seq;
      replayed++;
    }
    if (page.length < PAGE) break;
  }
  return { rga, seq, snapshotSeq, replayed };
}
