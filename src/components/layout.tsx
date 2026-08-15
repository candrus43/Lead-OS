/**
 * App shell — dark premium Operion module layout: aurora background, grid fade,
 * left module navigation, top bar.
 */

import { Link, useLocation } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useAuth } from "./AuthGate";
import { Icon } from "./ui";

const NAV = [
  { to: "/", label: "Dashboard", icon: "dashboard" as const },
  { to: "/search", label: "Prospect Search", icon: "search" as const },
  { to: "/bulk", label: "Bulk Analysis", icon: "play" as const },
  { to: "/prospects", label: "Prospects", icon: "list" as const },
  { to: "/lists", label: "Lists", icon: "layers" as const },
  { to: "/providers", label: "Providers & Data", icon: "database" as const },
  { to: "/settings", label: "Settings", icon: "settings" as const },
];

/** Agent accounts never see Settings / Providers & Data — hidden, not disabled. */
const AGENT_HIDDEN = new Set(["/providers", "/settings"]);

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

export function Shell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const { role, user, signOut } = useAuth();
  const visibleNav = NAV.filter((item) => (role === "agent" ? !AGENT_HIDDEN.has(item.to) : true));
  return (
    <div className="min-h-dvh">
      <AuroraBackdrop />
      <div className="flex min-h-dvh">
        {/* Sidebar */}
        <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col gap-6 border-r border-white/5 px-4 py-6 md:flex">
          <Link to="/" className="flex items-center gap-3 px-2">
            <img src="/operion-logo.png" alt="Operion" className="h-8 w-8 rounded-lg object-contain" />
            <span className="leading-tight">
              <span className="block text-sm font-bold tracking-tight text-fg">Operion</span>
              <span className="block text-[11px] font-medium uppercase tracking-label text-muted">Lead OS</span>
            </span>
          </Link>
          <nav className="flex flex-1 flex-col gap-1">
            <p className="eyebrow px-2 pb-2">Modules</p>
            {visibleNav.map((item) => {
              const active = item.to === "/" ? pathname === "/" : pathname.startsWith(item.to);
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={`group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
                    active ? "bg-white/5 text-fg" : "text-muted hover:bg-white/[.03] hover:text-fg"
                  }`}
                >
                  {active && <span className="bg-hairline absolute left-0 top-1/2 h-6 w-px -translate-y-1/2" style={{ backgroundImage: "linear-gradient(#0000,#a78bfa59,#0000)" }} />}
                  <Icon name={item.icon} className={`h-4 w-4 ${active ? "text-accent-light" : "text-muted group-hover:text-accent-light"}`} />
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="rounded-xl border border-white/5 bg-white/[.02] p-3">
            {role ? (
              <div className="flex items-center justify-between gap-2">
                <p className="flex items-center gap-1.5 text-[11px] font-medium text-fg">
                  <span className={`h-1.5 w-1.5 rounded-full ${role === "owner" ? "bg-accent-light" : "bg-success"}`} />
                  {role === "owner" ? "Owner" : "Agent"}
                </p>
                <button
                  type="button"
                  onClick={() => void signOut()}
                  className="text-[11px] text-muted underline-offset-2 hover:text-fg hover:underline"
                >
                  Sign out
                </button>
              </div>
            ) : (
              <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted">
                <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
                Private · Internal
              </p>
            )}
            <p className="mt-1 text-[11px] leading-relaxed text-faint">
              {role ? `Signed in as ${user}` : "Operion Lead OS — lead intelligence. Not a CRM."}
            </p>
          </div>
        </aside>

        {/* Main */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Mobile top bar */}
          <header className="sticky top-0 z-30 flex items-center justify-between border-b border-white/5 bg-ink/80 px-4 py-3 backdrop-blur-md md:hidden">
            <span className="flex items-center gap-2">
              <img src="/operion-logo.png" alt="Operion" className="h-6 w-6 rounded-md object-contain" />
              <span className="text-sm font-bold tracking-tight text-fg">
                Operion <span className="text-muted">Lead OS</span>
              </span>
            </span>
          </header>
          {/* Mobile nav */}
          <nav className="sticky top-[49px] z-30 flex gap-1 overflow-x-auto border-b border-white/5 bg-ink/80 px-3 py-2 backdrop-blur-md md:hidden">
            {visibleNav.map((item) => {
              const active = item.to === "/" ? pathname === "/" : pathname.startsWith(item.to);
              return (
                <Link key={item.to} to={item.to} className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium ${active ? "bg-white/10 text-fg" : "text-muted"}`}>
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:px-10">{children}</main>
          <footer className="mx-auto w-full max-w-7xl px-4 pb-6 sm:px-6 lg:px-10">
            <p className="border-t border-white/5 pt-4 text-[11px] text-faint">
              Operion Lead OS · Internal tool · Data quality is labeled honestly — nothing is fabricated.
            </p>
          </footer>
        </div>
      </div>
    </div>
  );
}
