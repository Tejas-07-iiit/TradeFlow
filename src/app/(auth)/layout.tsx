import Link from "next/link";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative min-h-screen flex">
      {/* Left brand panel */}
      <aside className="relative hidden lg:flex w-[44%] xl:w-[40%] flex-col justify-between p-10 border-r border-[var(--border)] bg-[var(--sidebar-bg)] grid-bg overflow-hidden">
        <div className="absolute inset-0 pointer-events-none [background:radial-gradient(800px_400px_at_10%_10%,rgba(0,212,255,0.08),transparent_60%),radial-gradient(800px_400px_at_90%_90%,rgba(0,230,118,0.04),transparent_60%)]" />
        <Link href="/" className="relative flex items-center gap-2.5 z-10">
          <span
            aria-hidden
            className="inline-block h-6 w-6 rounded-md"
            style={{
              background:
                "conic-gradient(from 220deg at 50% 50%, #00d4ff, #00e676, #00d4ff)",
              boxShadow: "var(--logo-glow)",
            }}
          />
          <span className="text-sm font-semibold tracking-[0.18em] uppercase text-[var(--fg)]">
            TradeFlow
          </span>
        </Link>

        <div className="relative z-10 max-w-md space-y-6">
          <p className="text-[11px] uppercase tracking-[0.22em] text-[var(--accent)]/80">
            Institutional · AI-Assisted · Paper Trading
          </p>
          <h1 className="text-4xl font-semibold leading-tight tracking-tight text-[var(--fg)]">
            An intelligent trading terminal that explains its decisions.
          </h1>
          <p className="text-sm leading-relaxed text-[var(--fg-muted)]">
            Bloomberg-grade workspace, live market microstructure, and a
            decision panel that surfaces the reasoning behind every signal —
            not a black box.
          </p>

          <div className="grid grid-cols-3 gap-4 pt-2">
            {[
              { k: "Latency", v: "<50ms" },
              { k: "Universe", v: "BTC · ETH · 200+" },
              { k: "Paper $", v: "$10,000" },
            ].map((s) => (
              <div
                key={s.k}
                className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2.5"
              >
                <div className="text-[10px] uppercase tracking-wide text-[var(--fg-subtle)]">
                  {s.k}
                </div>
                <div className="text-mono-tabular text-sm text-[var(--fg)] mt-0.5">
                  {s.v}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="relative z-10 text-[11px] text-[var(--fg-subtle)]">
          © {new Date().getFullYear()} TradeFlow · Simulation environment.
          No real funds are at risk.
        </div>
      </aside>

      {/* Right form panel */}
      <main className="flex-1 flex items-center justify-center p-6 lg:p-10">
        <div className="w-full max-w-md fade-in">{children}</div>
      </main>
    </div>
  );
}
