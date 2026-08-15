import { HeadContent, Outlet, Scripts, createRootRoute, useMatches } from "@tanstack/react-router";
import type { ReactNode } from "react";
import appCss from "~/styles/app.css?url";
import { AuthGate } from "~/components/AuthGate";
import { Shell } from "~/components/layout";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Operion Lead OS — Lead Intelligence" },
      { name: "description", content: "Private lead-intelligence engine for Operion: find, score and qualify the 10 companies to contact today." },
    ],
    links: [
      { rel: "icon", href: "/operion-logo.png" },
      { rel: "stylesheet", href: appCss },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" },
    ],
  }),
  notFoundComponent: () => <div className="p-10 text-muted">Page not found</div>,
  component: RootComponent,
});

function RootComponent() {
  const matches = useMatches();
  // The login route is a standalone full-screen page (no sidebar shell).
  const isLogin = matches.some((m) => m.routeId === "/login");
  return (
    <RootDocument>
      <AuthGate>
        {isLogin ? <Outlet /> : <Shell><Outlet /></Shell>}
      </AuthGate>
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body className="bg-ink text-fg">
        {children}
        <Scripts />
      </body>
    </html>
  );
}
