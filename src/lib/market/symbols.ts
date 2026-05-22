/**
 * Active trading universe.
 *
 * `ACTIVE_SYMBOLS` is the SINGLE source of truth for which symbols the
 * autonomous orchestrator scans, generates thesis/decision/news for, and
 * subscribes to over websocket. Every active code path — scheduler,
 * provider, subscriber, watchlist UI — imports this constant.
 *
 * Historical data (closed trades, persisted explainability rows, cached
 * news-store entries, chart history) MUST still render for symbols that
 * once traded but are no longer in this list — `SYMBOL_NAMES` keeps the
 * label mappings for that purpose.
 *
 * Removed 2026-05-22: XRPUSDT (autonomous orchestration only — historical
 * XRP data still resolves through SYMBOL_NAMES).
 */
export const ACTIVE_SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
] as const;

export type ActiveSymbol = (typeof ACTIVE_SYMBOLS)[number];

/**
 * Back-compat alias. `WATCHLIST_SYMBOLS` was the legacy name used across
 * the UI; new code should import `ACTIVE_SYMBOLS` directly. We keep the
 * alias so existing imports keep building without sweeping every file.
 */
export const WATCHLIST_SYMBOLS = ACTIVE_SYMBOLS;

export type WatchlistSymbol = ActiveSymbol;

/**
 * Display labels. Includes historical symbols (XRP) so that closed-position
 * tables and chart history can still resolve a human-readable name.
 */
export const SYMBOL_NAMES: Record<string, string> = {
  BTCUSDT: "Bitcoin",
  ETHUSDT: "Ethereum",
  SOLUSDT: "Solana",
  BNBUSDT: "BNB",
  XRPUSDT: "XRP",
};

/** Type-guard: is this symbol currently in the active orchestration set? */
export function isActiveSymbol(s: string): s is ActiveSymbol {
  return (ACTIVE_SYMBOLS as readonly string[]).includes(s);
}
