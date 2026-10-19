import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { User, api, setUnauthorizedHandler, tokenStore } from './api';

interface AuthState {
  user: User | null;
  loading: boolean;
  login(email: string, password: string): Promise<void>;
  register(name: string, email: string, password: string): Promise<void>;
  logout(): void;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const logout = useCallback(() => {
    tokenStore.clear();
    setUser(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    if (!tokenStore.get()) {
      setLoading(false);
      return () => setUnauthorizedHandler(null);
    }
    api
      .me()
      .then((r) => setUser(r.user))
      .catch(() => tokenStore.clear())
      .finally(() => setLoading(false));
    return () => setUnauthorizedHandler(null);
  }, [logout]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      logout,
      async login(email, password) {
        const r = await api.login(email, password);
        tokenStore.set(r.token);
        setUser(r.user);
      },
      async register(name, email, password) {
        const r = await api.register(name, email, password);
        tokenStore.set(r.token);
        setUser(r.user);
      },
    }),
    [user, loading, logout],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
