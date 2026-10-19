import { FormEvent, useState } from 'react';
import { ApiError, api } from '../api';

export function ShareDialog({ docId, onClose }: { docId: string; onClose(): void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'editor' | 'viewer'>('editor');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api.share(docId, email.trim(), role);
      setMsg({ kind: 'ok', text: `Shared with ${email.trim()} as ${role}. Role changes apply the next time they open the document.` });
      setEmail('');
    } catch (err) {
      setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not share' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="card modal" onSubmit={submit} onMouseDown={(e) => e.stopPropagation()}>
        <h2>Share document</h2>
        <p className="muted small">The person needs an account already. Sharing again with a new role updates it.</p>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
        <label>
          Permission
          <select value={role} onChange={(e) => setRole(e.target.value as 'editor' | 'viewer')}>
            <option value="editor">Editor — can edit</option>
            <option value="viewer">Viewer — read only</option>
          </select>
        </label>
        {msg && <div className={`alert ${msg.kind}`}>{msg.text}</div>}
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>
            Close
          </button>
          <button className="btn primary" disabled={busy}>
            Share
          </button>
        </div>
      </form>
    </div>
  );
}
