import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, api } from '../api';
import { useAuth } from '../auth';
import { CollabEditor } from '../components/CollabEditor';
import { ShareDialog } from '../components/ShareDialog';
import { VersionPanel } from '../components/VersionPanel';
import { ConnStatus } from '../collab/client';
import { useCollab } from '../collab/useCollab';
import { initials } from '../lib/format';
import { countWords } from '../lib/textdiff';

const STATUS_LABEL: Record<ConnStatus, string> = {
  connecting: 'Connecting…',
  online: 'Connected',
  reconnecting: 'Reconnecting…',
  denied: 'No access',
  closed: 'Disconnected',
};

export function EditorPage() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const collab = useCollab(id, user?.id ?? '');
  const { client, text, status, role, collaborators } = collab;

  const [title, setTitle] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showShare, setShowShare] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    api
      .getDoc(id)
      .then((r) => !cancelled && setTitle(r.document.title))
      .catch((e) => !cancelled && setLoadError(e instanceof ApiError ? e.message : 'Could not open the document'));
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    if (collab.remoteTitle !== null) setTitle(collab.remoteTitle);
  }, [collab.remoteTitle]);

  useEffect(() => {
    document.title = title ? `${title} — Eventually Consistent` : 'Eventually Consistent';
    return () => {
      document.title = 'Eventually Consistent';
    };
  }, [title]);

  const canEdit = role !== 'viewer';
  const online = status === 'online';
  const readOnly = !canEdit || status === 'connecting' || status === 'denied';
  const others = collaborators.filter((c) => c.siteId !== client?.siteId);

  async function commitTitle() {
    const t = title.trim();
    if (!canEdit || !t) return;
    try {
      await api.renameDoc(id, t);
    } catch (e) {
      alert(e instanceof ApiError ? e.message : 'Rename failed');
    }
  }

  if (loadError) {
    return (
      <div className="center-screen">
        <div className="card auth-card">
          <h1>Document unavailable</h1>
          <p className="muted">{loadError}</p>
          <Link className="btn primary" to="/">
            Back to documents
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page editor-page">
      <header className="topbar">
        <Link to="/" className="btn ghost" title="All documents">
          ←
        </Link>
        <input
          className="title-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => void commitTitle()}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          readOnly={!canEdit}
          maxLength={200}
          aria-label="Document title"
        />
        <span className={`badge ${role}`}>{role}</span>
        <div className="spacer" />

        <div className="avatars" aria-label="Collaborators">
          {others.slice(0, 6).map((c) => (
            <span key={c.siteId} className="avatar" style={{ background: c.color }} title={c.name}>
              {initials(c.name)}
            </span>
          ))}
          {others.length > 6 && <span className="avatar more">+{others.length - 6}</span>}
        </div>

        <button className="btn" disabled={!canEdit || !online} onClick={() => client?.undo()} title="Undo my last edit (Ctrl/⌘+Z)">
          ↶ Undo
        </button>
        <button className="btn" disabled={!canEdit || !online} onClick={() => client?.redo()} title="Redo (Ctrl/⌘+Shift+Z)">
          ↷ Redo
        </button>
        <button className={`btn ${showHistory ? 'active' : ''}`} onClick={() => setShowHistory((v) => !v)}>
          🕘 History
        </button>
        {role === 'owner' && (
          <button className="btn primary" onClick={() => setShowShare(true)}>
            Share
          </button>
        )}
        <span className={`status ${status}`}>
          <i /> {STATUS_LABEL[status]}
        </span>
      </header>

      {collab.error && (
        <div className="alert error banner">
          {collab.error}
          <button className="link" onClick={collab.dismissError}>
            Dismiss
          </button>
        </div>
      )}
      {status === 'reconnecting' && (
        <div className="alert warn banner">Connection lost — your edits are kept and will sync when you are back online.</div>
      )}

      <div className="editor-layout">
        <main className="editor-main card">
          {client ? (
            <CollabEditor client={client} text={text} collaborators={collaborators} readOnly={readOnly} />
          ) : (
            <div className="muted pad">Loading…</div>
          )}
          <footer className="editor-footer muted small">
            <span>
              {Array.from(text).length.toLocaleString()} characters · {countWords(text).toLocaleString()} words
            </span>
            <span>{role === 'viewer' ? 'Read-only access' : others.length ? `${others.length} other${others.length > 1 ? 's' : ''} here` : 'Only you here'}</span>
          </footer>
        </main>

        {showHistory && (
          <VersionPanel docId={id} canEdit={canEdit} liveSeq={collab.seq} onClose={() => setShowHistory(false)} />
        )}
      </div>

      {showShare && <ShareDialog docId={id} onClose={() => setShowShare(false)} />}
    </div>
  );
}
