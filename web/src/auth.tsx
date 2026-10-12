// Account state for the whole app: who is logged in, whether first-run setup
// is needed, and helpers to log out / refresh after a 401.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

export interface User {
  id: string;
  username: string;
  role: "owner" | "admin" | "user";
  /** "guest": no passkey; signs in with one-time sign-in codes. */
  kind: "full" | "guest";
  created_at: string;
  last_login: string | null;
}

export interface AuthStatus {
  setup_required: boolean;
  auth_disabled: boolean;
  authenticated: boolean;
  user: User | null;
  /** Groups offered on the sign-in page. */
  join_groups: { id: string; name: string; description: string }[];
}

interface AuthContextValue {
  /** undefined while the first status request is in flight. */
  status: AuthStatus | undefined;
  /** True if the status request itself failed (server unreachable). */
  offline: boolean;
  user: User | null;
  isAdmin: boolean;
  isGuest: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | undefined>(undefined);
  const [offline, setOffline] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/status", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus((await res.json()) as AuthStatus);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    await refresh();
  }, [refresh]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const value = useMemo<AuthContextValue>(() => {
    const user = status?.user ?? null;
    return {
      status,
      offline,
      user,
      isAdmin: user?.role === "owner" || user?.role === "admin",
      isGuest: user?.kind === "guest",
      refresh,
      logout,
    };
  }, [status, offline, refresh, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

/** JSON POST/PUT helper that surfaces the server's {error} message. */
export async function apiJson<T = unknown>(
  url: string,
  method: "POST" | "PUT" | "DELETE",
  body?: unknown,
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}
