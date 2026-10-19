import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../api';
import { useAuth } from '../auth';

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { login, register } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isRegister = mode === 'register';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (isRegister) await register(name.trim(), email.trim(), password);
      else await login(email.trim(), password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-screen">
      <form className="card auth-card" onSubmit={submit}>
        <div className="brand big">
          <span className="logo">✍️</span> Eventually Consistent
        </div>
        <p className="muted">Real-time collaborative writing, merged by a CRDT.</p>
        <h1>{isRegister ? 'Create your account' : 'Welcome back'}</h1>

        {isRegister && (
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} autoFocus />
          </label>
        )}
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            maxLength={254}
            autoFocus={!isRegister}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            maxLength={200}
            autoComplete={isRegister ? 'new-password' : 'current-password'}
          />
          {isRegister && <small className="muted">At least 8 characters.</small>}
        </label>

        {error && <div className="alert error">{error}</div>}
        <button className="btn primary" disabled={busy}>
          {busy ? 'Please wait…' : isRegister ? 'Sign up' : 'Log in'}
        </button>
        <p className="muted center">
          {isRegister ? (
            <>
              Already have an account? <Link to="/login">Log in</Link>
            </>
          ) : (
            <>
              New here? <Link to="/register">Create an account</Link>
            </>
          )}
        </p>
      </form>
    </div>
  );
}
