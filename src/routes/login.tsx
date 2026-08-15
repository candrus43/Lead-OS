/**
 * Login — Operion CRM-style sign-in: aurora backdrop, glass card, gradient
 * headline, icon-tile logo. Usernames are fixed: "owner" / "agent".
 * On success the app hard-navigates to the page the user tried to open
 * (?next=), which makes AuthGate re-read the fresh HttpOnly session cookie.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { login } from "~/lib/authServer";
import { useAuth } from "~/components/AuthGate";
import { Icon } from "~/components/ui";

export const Route = createFileRoute("/login")({
  validateSearch: (s: Record<string, unknown>) => ({
    // only allow in-app paths (blocks open redirects like //evil.com)
    next: typeof s.next === "string" && s.next.startsWith("/") && !s.next.startsWith("//") ? s.next : undefined,
  }),
  component: LoginPage,
});

function AuroraBackdrop() {
  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-ink">
      <div className="bg-grid-fade absolute inset-0 [mask-image:radial-gradient(75%_60%_at_50%_40%,#000_0%,#0000_78%)]" />
      <div className="aurora-blob aurora-a left-[-10%] top-[-15%] h-[46rem] w-[46rem] animate-breathe" style={{ backgroundImage: "linear-gradient(145deg,#a78bfaa6 0%,#60a5fa47 38%,#ffffff0d 62%,#0000 100%)" }} />
      <div className="aurora-blob aurora-b right-[-12%] top-[20%] h-[40rem] w-[40rem]" style={{ animation: "aurora-b 9s ease-in-out infinite, breathe 7s ease-in-out infinite", backgroundImage: "linear-gradient(145deg,#60a5fa59 0%,#a78bfa40 45%,#0000 70%)" }} />
      <div className="aurora-blob aurora-c bottom-[-20%] left-[25%] h-[38rem] w-[38rem]" style={{ animation: "aurora-c 11s ease-in-out infinite, breathe 8s ease-in-out infinite", backgroundImage: "linear-gradient(145deg,#a78bfa40 0%,#60a5fa26 40%,#0000 75%)" }} />
      <div className="bg-hairline absolute left-1/2 top-0 h-px w-2/3 -translate-x-1/2" />
    </div>
  );
}

function LoginPage() {
  const { next } = Route.useSearch();
  const { session, loading } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Already signed in → go straight to the app (or their intended page).
  useEffect(() => {
    if (!loading && session?.authenticated) {
      window.location.assign(next || "/");
    }
  }, [loading, session, next]);

  const go = (target: string) => {
    window.location.assign(target);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await login({ data: { username: username.trim(), password } });
      if (res.ok) {
        go(next || "/");
        return;
      }
      setError(res.error === "invalid-credentials" ? "Incorrect username or password." : "Sign-in isn't available right now.");
    } catch {
      setError("Couldn't reach the sign-in service — try again in a moment.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <AuroraBackdrop />
      <div className="glass anim-rise w-full max-w-sm p-8">
        <div className="flex flex-col items-center text-center">
          <div className="icon-tile h-14 w-14 rounded-2xl">
            <img src="/operion-logo.png" alt="Operion" className="h-9 w-9 rounded-lg object-contain" />
          </div>
          <h1 className="mt-5 text-2xl font-extrabold tracking-head text-gradient-violet">Operion Lead OS</h1>
          <p className="mt-1.5 text-sm text-muted">Sign in to Lead Intelligence</p>
        </div>

        {session && !session.authConfigured ? (
          <div className="mt-6 rounded-xl border border-white/10 bg-white/[.03] p-4 text-center">
            <p className="flex items-center justify-center gap-2 text-sm text-warn">
              <Icon name="shield" className="h-4 w-4" /> Logins aren&apos;t configured
            </p>
            <p className="mt-2 text-xs leading-relaxed text-muted">
              Set <span className="font-mono text-faint">OPERION_OWNER_PASSWORD</span> and{" "}
              <span className="font-mono text-faint">OPERION_AGENT_PASSWORD</span> to enable sign-in.
            </p>
            <Link to="/" className="btn-ghost mt-4 w-full">Back to the app</Link>
          </div>
        ) : (
          <form onSubmit={(e) => void submit(e)} className="mt-6 space-y-4">
            <div>
              <label htmlFor="username" className="eyebrow mb-1.5 block">Username</label>
              <input
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                placeholder="owner or agent"
                className="input-dark"
                autoFocus
              />
            </div>
            <div>
              <label htmlFor="password" className="eyebrow mb-1.5 block">Password</label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                placeholder="••••••••"
                className="input-dark"
              />
            </div>
            {error && <p className="text-xs text-danger">{error}</p>}
            <button type="submit" disabled={busy || !username.trim() || !password} className="btn-primary w-full">
              {busy ? "Signing in…" : "Sign in"}
            </button>
            <p className="text-center text-[11px] text-faint">
              Internal tool · Fixed accounts: <span className="font-mono">owner</span> and <span className="font-mono">agent</span>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
