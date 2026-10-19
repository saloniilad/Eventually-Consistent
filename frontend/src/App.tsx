import { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { DocsPage } from './pages/DocsPage';
import { EditorPage } from './pages/EditorPage';
import { AuthPage } from './pages/AuthPage';

function Protected({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <div className="center-screen muted">Loading…</div>;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <>{children}</>;
}

export function App() {
  const { user, loading } = useAuth();
  return (
    <Routes>
      <Route
        path="/login"
        element={loading ? null : user ? <Navigate to="/" replace /> : <AuthPage mode="login" />}
      />
      <Route
        path="/register"
        element={loading ? null : user ? <Navigate to="/" replace /> : <AuthPage mode="register" />}
      />
      <Route
        path="/"
        element={
          <Protected>
            <DocsPage />
          </Protected>
        }
      />
      <Route
        path="/doc/:id"
        element={
          <Protected>
            <EditorPage />
          </Protected>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
