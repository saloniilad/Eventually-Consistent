import { useCallback, useEffect, useState } from 'react';
import { ApiError, Comparison, VersionList, api } from '../api';
import { timeAgo } from '../lib/format';

interface Props {
  docId: string;
  canEdit: boolean;
  /** Latest server seq this tab knows about; used to hint that the history list is stale. */
  liveSeq: number;
  onClose(): void;
}

const MAX_DIFF_LINES = 2000;

export function VersionPanel({ docId, canEdit, liveSeq, onClose }: Props) {
  const [versions, setVersions] = useState<VersionList | null>(null);
  const [sel, setSel] = useState<number | null>(null); // null = head
  const [cmp, setCmp] = useState<Comparison | null>(null);
  const [tab, setTab] = useState<'diff' | 'text'>('diff');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setVersions(await api.versions(docId));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load history');
    }
  }, [docId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const head = versions?.head ?? 0;
  const seq = sel ?? head;

  // Load the selected version compared with the current head (debounced while dragging the slider).
  useEffect(() => {
    if (!versions) return;
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      api
        .compare(docId, seq)
        .then((c) => {
          if (!cancelled) {
            setCmp(c);
            setError(null);
          }
        })
        .catch((e) => {
          if (!cancelled) setError(e instanceof ApiError ? e.message : 'Could not load that version');
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [docId, seq, versions]);

  async function restore() {
    if (!window.confirm(`Restore the document to operation #${seq}?\n\nThis is saved as a new edit; nothing in the history is lost.`)) return;
    setRestoring(true);
    try {
      const r = await api.restore(docId, seq);
      setNotice(`Restored (+${r.inserted} / −${r.deleted} characters).`);
      setSel(null);
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Restore failed');
    } finally {
      setRestoring(false);
    }
  }

  const atHead = seq >= head;
  const stale = liveSeq > head;

  return (
    <aside className="history card">
      <div className="row between">
        <h2>Version history</h2>
        <div className="row">
          <button className="btn ghost small" onClick={() => void refresh()} title="Reload history">
            ↻
          </button>
          <button className="btn ghost small" onClick={onClose} aria-label="Close history">
            ✕
          </button>
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert ok">{notice}</div>}
      {!versions && !error && <p className="muted">Loading…</p>}

      {versions && (
        <>
          <label className="slider">
            <span>
              Operation <b>#{seq}</b> of {head}
              {atHead && <span className="muted"> (current)</span>}
            </span>
            <input
              type="range"
              min={0}
              max={Math.max(head, 0)}
              value={Math.min(seq, head)}
              onChange={(e) => {
                setNotice(null);
                setSel(Number(e.target.value));
              }}
              disabled={head === 0}
            />
          </label>
          {stale && (
            <p className="muted small">
              Newer edits exist.{' '}
              <button className="link" onClick={() => void refresh()}>
                Refresh
              </button>
            </p>
          )}

          <div className="chips">
            <button className={`chip ${atHead ? 'active' : ''}`} onClick={() => setSel(null)}>
              Latest
            </button>
            <button className={`chip ${seq === 0 ? 'active' : ''}`} onClick={() => setSel(0)}>
              Empty
            </button>
            {versions.snapshots.map((s) => (
              <button
                key={s.seq}
                className={`chip ${seq === s.seq ? 'active' : ''}`}
                onClick={() => {
                  setNotice(null);
                  setSel(s.seq);
                }}
                title={new Date(s.createdAt).toLocaleString()}
              >
                #{s.seq} · {timeAgo(s.createdAt)}
              </button>
            ))}
          </div>

          <div className="tabs">
            <button className={tab === 'diff' ? 'active' : ''} onClick={() => setTab('diff')}>
              Changes since
            </button>
            <button className={tab === 'text' ? 'active' : ''} onClick={() => setTab('text')}>
              Text at #{seq}
            </button>
          </div>

          <div className={`history-body ${loading ? 'dim' : ''}`}>
            {cmp && tab === 'text' && <pre className="plain">{cmp.from.text || '(empty document)'}</pre>}
            {cmp && tab === 'diff' && <DiffView cmp={cmp} atHead={atHead} />}
          </div>

          {canEdit && (
            <button className="btn primary" disabled={atHead || restoring || loading} onClick={() => void restore()}>
              {restoring ? 'Restoring…' : `Restore #${seq}`}
            </button>
          )}
        </>
      )}
    </aside>
  );
}

function DiffView({ cmp, atHead }: { cmp: Comparison; atHead: boolean }) {
  if (atHead || cmp.from.text === cmp.to.text) return <p className="muted">Identical to the current document.</p>;
  const lines = cmp.diff.slice(0, MAX_DIFF_LINES);
  return (
    <>
      <p className="muted small">
        <span className="legend del">− in that version only</span> <span className="legend add">+ in current only</span>
      </p>
      <pre className="diff">
        {lines.map((l, i) => (
          <div key={i} className={`dl ${l.type}`}>
            <span className="sign">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
            {l.text || ' '}
          </div>
        ))}
        {cmp.diff.length > lines.length && <div className="muted">… {cmp.diff.length - lines.length} more lines</div>}
      </pre>
    </>
  );
}
