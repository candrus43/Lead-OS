/**
 * Operion Lead OS — shared component vocabulary, built from the Operion design
 * tokens (dark premium: ink background, violet/blue aurora, glass cards).
 */

import type { ReactNode } from "react";
import { useState } from "react";
import type { Contactable, Provenance, VerificationStatus } from "~/lib/types";

/* ---------------------------------- icons ---------------------------------- */

const paths: Record<string, ReactNode> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  list: (
    <>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <circle cx="3.5" cy="6" r="1" fill="currentColor" stroke="none" />
      <circle cx="3.5" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="3.5" cy="18" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  layers: (
    <>
      <path d="m12 2 9 5-9 5-9-5 9-5Z" />
      <path d="m3 12 9 5 9-5" />
      <path d="m3 17 9 5 9-5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h0a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h0a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v0a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z" />
    </>
  ),
  sparkle: <path d="M12 2 14.4 9.6 22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4L12 2Z" />,
  bolt: <path d="M13 2 3 14h7l-1 8 11-13h-7l1-7Z" />,
  check: <path d="m4 12.5 5 5L20 6.5" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  upload: (
    <>
      <path d="M12 16V4m0 0L7 9m5-5 5 5" />
      <path d="M4 20h16" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
      <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
    </>
  ),
  shield: (
    <>
      <path d="M12 2 4 5v6c0 5.25 3.4 9.74 8 11 4.6-1.26 8-5.75 8-11V5l-8-3Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  play: (
    <>
      <path d="M6 4.5v15l13-7.5-13-7.5Z" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
};

export function Icon({ name, className = "h-4 w-4" }: { name: keyof typeof paths; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      {paths[name]}
    </svg>
  );
}

/* ---------------------------------- atoms ---------------------------------- */

export function Card({ children, className = "", glow = false }: { children: ReactNode; className?: string; glow?: boolean }) {
  return (
    <div className={`glass ${glow ? "shadow-[0_0_60px_-20px_rgba(139,92,246,0.45)]" : ""} ${className}`}>{children}</div>
  );
}

export function Badge({ children, variant = "neutral", className = "" }: { children: ReactNode; variant?: "neutral" | "violet" | "green" | "amber" | "red" | "sample" | "mock"; className?: string }) {
  const v = { neutral: "", violet: "badge-violet", green: "badge-green", amber: "badge-amber", red: "badge-red", sample: "badge-sample", mock: "badge-mock" }[variant];
  return <span className={`badge ${v} ${className}`}>{children}</span>;
}

const STATUS_STYLE: Record<VerificationStatus, { cls: string; dot: string }> = {
  Verified: { cls: "badge-green", dot: "bg-success" },
  "High Confidence": { cls: "badge-green", dot: "bg-success/70" },
  Likely: { cls: "badge-violet", dot: "bg-accent-light" },
  Unverified: { cls: "badge-amber", dot: "bg-warn" },
  Unknown: { cls: "", dot: "bg-muted" },
};

export function StatusPill({ status, label }: { status: VerificationStatus; label?: string }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.Unknown;
  return (
    <span className={`badge ${s.cls}`} title={`Verification: ${status}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot} ${status === "Verified" ? "animate-pulse" : ""}`} />
      {label ?? status}
    </span>
  );
}

export function ProvenanceTag({ p, className = "" }: { p?: Provenance; className?: string }) {
  if (!p) return <span className="text-muted">—</span>;
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-sm ${className}`}
      title={`Source: ${p.source} · Captured: ${new Date(p.capturedAt).toLocaleString()} · Confidence: ${Math.round(p.confidence * 100)}%`}
    >
      {p.value}
      <StatusPill status={p.verificationStatus} />
    </span>
  );
}

export function FitBadge({ score, className = "" }: { score: number; className?: string }) {
  const band = score >= 75 ? "badge-green" : score >= 55 ? "badge-violet" : score >= 35 ? "badge-amber" : "";
  return (
    <span className={`badge ${band} font-mono ${className}`} title={`Operion Fit Score: ${score}/100`}>
      {score}
      <span className="text-muted">fit</span>
    </span>
  );
}

export function ContactabilityPill({ band }: { band: Contactable }) {
  const map = {
    High: { cls: "badge-green", icon: "check" },
    Medium: { cls: "badge-violet", icon: "bolt" },
    Low: { cls: "badge-amber", icon: "bolt" },
    None: { cls: "", icon: "eye" },
  } as const;
  const m = map[band];
  return (
    <span className={`badge ${m.cls}`} title="Contactability of the primary contact (email/phone verification)">
      <Icon name={m.icon} className="h-3 w-3" />
      {band}
    </span>
  );
}

export function Button({ children, variant = "primary", className = "", disabled, onClick }: { children: ReactNode; variant?: "primary" | "ghost"; className?: string; disabled?: boolean; onClick?: () => void }) {
  const cls = variant === "primary" ? "btn-primary" : "btn-ghost";
  return (
    <button type="button" className={`${cls} ${className}`} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

export function SectionHead({ eyebrow, title, desc, right }: { eyebrow?: string; title: string; desc?: string; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="space-y-1.5">
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1 className="text-2xl font-bold tracking-head text-fg sm:text-3xl">{title}</h1>
        {desc && <p className="max-w-2xl text-sm text-muted">{desc}</p>}
      </div>
      {right}
    </div>
  );
}

/* ---------------------------------- modal ---------------------------------- */

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="glass anim-rise relative w-full max-w-md p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold tracking-head text-fg">{title}</h3>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-muted hover:bg-white/5 hover:text-fg" aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ---------------------------------- misc ---------------------------------- */

export function FitBar({ score }: { score: number }) {
  const color = score >= 75 ? "from-emerald-400 to-success" : score >= 55 ? "from-accent-light to-accent" : score >= 35 ? "from-warn to-amber-400" : "from-muted to-muted";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/5">
      <div className={`h-full rounded-full bg-gradient-to-r ${color}`} style={{ width: `${score}%` }} />
    </div>
  );
}

export function useModal() {
  const [open, setOpen] = useState(false);
  return { open, openModal: () => setOpen(true), closeModal: () => setOpen(false) };
}
