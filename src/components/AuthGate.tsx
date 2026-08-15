/**
 * AuthGate — app-wide session provider + route guard.
 *
 * On mount it asks the server for the session (reads the HttpOnly cookie
 * server-side). Until that resolves, children are not rendered, so an
 * unauthenticated user never sees a flash of protected content.
 *
 * Guard rules:
 *   - auth configured + no session   → redirect to /login?next=<path>
 *   - signed-in agent hits /settings or /providers → redirect to /
 *     (the routes also self-guard via guardModule and the nav hides the links)
 *   - signed-in user visits /login   → redirect to /
 *
 * Open mode (no passwords configured) disables every redirect.
 */

import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { getSession, logout } from "~/lib/authServer";
import type { SessionState } from "~/lib/authServer";
import type { Role } from "~/lib/auth";

interface AuthContextValue {
  loading: boolean;
  session: SessionState | null;
  role: Role | null;
  user: string | null;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  loading: true,
  session: null,
  role: null,
  user: null,
  signOut: async () => undefined,
});

export function useAuth() {
  return useContext(AuthContext);
}

const AGENT_FORBIDDEN_PREFIXES = ["/settings", "/providers"];

/** Friendly full-page state shown when the server denies module access. */
export function RoleNotAllowed() {
  return (
    <div className="mx-auto mt-16 max-w-md">
      <div className="glass p-8 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-white/5">
          <span className="text-warn">⛔</span>
        </div>
        <h1 className="mt-4 text-lg font-semibold tracking-head text-fg">Not available for your role</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Agent accounts don&apos;t have access to this module. If you think this is wrong, ask the account owner to adjust access.
        </p>
      </div>
    </div>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<SessionState | null>(null);

  // Fetch the session once on mount (client-only — cookie is HttpOnly).
  useEffect(() => {
    let cancelled = false;
    getSession()
      .then((s) => {
        if (!cancelled) {
          setSession(s);
          setLoading(false);
        }
      })
      .catch(() => {
        // Server unreachable — treat as open mode so the app still renders.
        if (!cancelled) {
          setSession({ role: null, user: null, authConfigured: false, authenticated: false });
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Route guards (run after the session resolves).
  useEffect(() => {
    if (loading || !session) return;
    const authed = session.authConfigured && session.authenticated;

    if (session.authConfigured && !authed && pathname !== "/login") {
      void navigate({ to: "/login", search: { next: pathname } });
      return;
    }
    if (authed) {
      if (pathname === "/login") {
        void navigate({ to: "/" });
        return;
      }
      if (session.role === "agent" && AGENT_FORBIDDEN_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
        void navigate({ to: "/" });
      }
    }
  }, [loading, session, pathname, navigate]);

  const signOut = async () => {
    try {
      await logout({ data: {} });
    } catch {
      // cookie clearing failed — still drop the client-side session
    }
    setSession((s) => (s ? { ...s, authenticated: false, role: null, user: null } : s));
    void navigate({ to: "/login", search: { next: undefined } });
  };

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-ink">
        <div className="flex items-center gap-3 text-sm text-muted">
          <span className="h-2 w-2 animate-pulse rounded-full bg-accent-light" />
          Loading…
        </div>
      </div>
    );
  }

  return (
    <AuthContext.Provider
      value={{
        loading,
        session,
        role: session?.authenticated ? session.role : null,
        user: session?.authenticated ? session.user : null,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
