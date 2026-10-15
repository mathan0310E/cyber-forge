import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, ApiClientError } from '../../lib/api';

export interface SessionUser {
  uid: string;
  email: string | null;
  displayName: string | null;
}

interface AuthState {
  user: SessionUser | null;
  loading: boolean;
  error: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, displayName?: string) => Promise<void>;
  signOut: () => Promise<void>;
  clearError: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

const TOKEN_KEY = 'wf_token';
const USER_KEY = 'wf_user';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(() => {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SessionUser;
    } catch {
      return null;
    }
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) {
      api.setToken(token);
      api
        .get<{ user: SessionUser }>('/auth/me')
        .then((r) => {
          setUser(r.user);
          localStorage.setItem(USER_KEY, JSON.stringify(r.user));
        })
        .catch((e: unknown) => {
          const err = e as ApiClientError;
          if (err.status === 401) {
            api.setToken(null);
            localStorage.removeItem(TOKEN_KEY);
            localStorage.removeItem(USER_KEY);
            setUser(null);
          }
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const persist = useCallback((token: string, u: SessionUser) => {
    api.setToken(token);
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(u));
    setUser(u);
    setError(null);
  }, []);

  const signIn = useCallback(
    async (email: string, password: string) => {
      try {
        const r = await api.post<{ token: string; user: SessionUser }>('/auth/login', {
          email,
          password,
        });
        persist(r.token, r.user);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Sign in failed.');
        throw e;
      }
    },
    [persist],
  );

  const signUp = useCallback(
    async (email: string, password: string, displayName?: string) => {
      try {
        const r = await api.post<{ token: string; user: SessionUser }>('/auth/signup', {
          email,
          password,
          displayName,
        });
        persist(r.token, r.user);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Sign up failed.');
        throw e;
      }
    },
    [persist],
  );

  const signOut = useCallback(async () => {
    try {
      await api.post('/auth/logout', {});
    } catch {
      /* token may already be invalid */
    }
    api.setToken(null);
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setUser(null);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const value = useMemo(
    () => ({ user, loading, error, signIn, signUp, signOut, clearError }),
    [user, loading, error, signIn, signUp, signOut, clearError],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}