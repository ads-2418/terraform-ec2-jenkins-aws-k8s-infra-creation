import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { api, setAccessToken } from "../api/client";

export interface CurrentUser {
  id: string;
  email: string;
  roles: string[];
}

interface AuthState {
  user: CurrentUser | null;
  loading: boolean;
  /** Omit tenantSlug (or pass "") to sign in as a platform admin. */
  login: (tenantSlug: string, email: string, password: string) => Promise<CurrentUser>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(false);

  const login = useCallback(async (tenantSlug: string, email: string, password: string) => {
    setLoading(true);
    try {
      const body: { tenantSlug?: string; email: string; password: string } = { email, password };
      if (tenantSlug) body.tenantSlug = tenantSlug;
      const result = await api.post<{ accessToken: string; user: CurrentUser }>("/v1/auth/login", body);
      setAccessToken(result.accessToken);
      setUser(result.user);
      return result.user;
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await api.post("/v1/auth/logout").catch(() => undefined);
    setAccessToken(null);
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, loading, login, logout }), [user, loading, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
