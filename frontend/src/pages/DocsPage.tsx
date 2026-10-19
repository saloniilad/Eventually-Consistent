import { FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, DocSummary, api } from '../api';
import { useAuth } from '../auth';
import { timeAgo } from '../lib/format';

export function DocsPage() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .listDocs()
      .then((r) => setDocs(r.documents))
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Failed to load documents'));
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.createDoc(title.trim() || 'Untitled');
      nav(`/doc/${r.document.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the document');
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          <span className="logo">✍️</span> Eventually Consistent
        </div>
        <div className="spacer" />
        <span className="muted hide-sm">{user?.name}</span>
        <button className="btn ghost" onClick={logout}>
          Log out
        </button>
      </header>

      <main className="container">
        <section className="card">
          <h2>New document</h2>
          <form className="row" onSubmit={create}>
            <input
              placeholder="Untitled"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              aria-label="Document title"
            />
            <button className="btn primary" disabled={busy}>
              Create
            </button>
          </form>
        </section>

        {error && <div className="alert error">{error}</div>}

        <section className="card">
          <h2>Your documents</h2>
          {docs === null && !error && <p className="muted">Loading…</p>}
          {docs?.length === 0 && <p className="muted">Nothing here yet — create your first document above.</p>}
          <ul className="doclist">
            {docs?.map((d) => (
              <li key={d.id}>
                <button className="docrow" onClick={() => nav(`/doc/${d.id}`)}>
                  <span className="doctitle">📄 {d.title}</span>
                  <span className={`badge ${d.role}`}>{d.role}</span>
                  <span className="muted small">{timeAgo(d.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
