-- ─────────────────────────────────────────────────────────────────────────────
-- normalize_equity_to_10000.sql
--
-- Rebases every PaperWallet's total equity to exactly $10,000 by scaling ONLY
-- monetary / position-size columns. Entry/exit prices, TP/SL prices, leverage,
-- risk-reward ratios, trade structure, timestamps, and analytics are preserved.
--
--   scaleFactor(user) = 10000 / (wallet.balance + Σ unrealizedPnl over OPEN /
--                                                  PARTIALLY_CLOSED positions)
--
-- Idempotency: after running, equity ≈ 10000. Re-running would scale 10000 →
-- 10000 (scale factor = 1), so it is safe to re-run if needed.
--
-- Transactional: wrapped in BEGIN / COMMIT. Any error rolls back.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Compute per-user current equity (balance + unrealized PnL on open positions).
CREATE TEMP TABLE _equity ON COMMIT DROP AS
SELECT
  w."userId"                                                           AS user_id,
  w.balance                                                            AS old_balance,
  w."usedMargin"                                                       AS old_used_margin,
  (
    w.balance
    + COALESCE((
        SELECT SUM(p."unrealizedPnl")
        FROM "PaperPosition" p
        WHERE p."userId" = w."userId"
          AND p.status IN ('OPEN', 'PARTIALLY_CLOSED')
      ), 0)
  )::numeric                                                           AS equity
FROM "PaperWallet" w;

-- Surface what we are about to do (pre-flight report).
SELECT
  user_id,
  old_balance,
  old_used_margin,
  equity                                AS old_equity,
  CASE WHEN equity > 0
       THEN ROUND(10000::numeric / equity, 12)
       ELSE NULL
  END                                   AS scale_factor
FROM _equity
ORDER BY user_id;

-- ── Scale wallet ─────────────────────────────────────────────────────────────
UPDATE "PaperWallet" w
SET
  balance     = (w.balance      * 10000::numeric) / e.equity,
  "usedMargin"= (w."usedMargin" * 10000::numeric) / e.equity,
  "updatedAt" = NOW()
FROM _equity e
WHERE w."userId" = e.user_id
  AND e.equity > 0;

-- ── Scale positions (qty + monetary cols, NOT prices / TP / SL / leverage) ──
UPDATE "PaperPosition" p
SET
  "initialQuantity"       = (p."initialQuantity"       * 10000::numeric) / e.equity,
  quantity                = (p.quantity                * 10000::numeric) / e.equity,
  "marginUsed"            = (p."marginUsed"            * 10000::numeric) / e.equity,
  "realizedPnl"           = (p."realizedPnl"           * 10000::numeric) / e.equity,
  "unrealizedPnl"         = (p."unrealizedPnl"         * 10000::numeric) / e.equity,
  "totalFees"             = (p."totalFees"             * 10000::numeric) / e.equity,
  "walletBalanceSnapshot" = CASE
                              WHEN p."walletBalanceSnapshot" IS NULL THEN NULL
                              ELSE (p."walletBalanceSnapshot" * 10000::numeric) / e.equity
                            END
FROM _equity e
WHERE p."userId" = e.user_id
  AND e.equity > 0;

-- ── Scale orders (only quantity; price / TP / SL are price levels) ──────────
UPDATE "PaperOrder" o
SET
  quantity = (o.quantity * 10000::numeric) / e.equity
FROM _equity e
WHERE o."userId" = e.user_id
  AND e.equity > 0;

-- ── Scale closed-trade history (qty + pnl only; entry / exit / RR preserved)
UPDATE "TradeHistory" t
SET
  quantity = (t.quantity * 10000::numeric) / e.equity,
  pnl      = (t.pnl      * 10000::numeric) / e.equity
FROM _equity e
WHERE t."userId" = e.user_id
  AND e.equity > 0;

-- ── Exact-equity fix-up ─────────────────────────────────────────────────────
-- Numeric round-trip can leave equity at 9999.99999998 etc. Nudge wallet
-- balance so post-state equity is exactly 10000 per user.
UPDATE "PaperWallet" w
SET balance = w.balance + (
      10000::numeric - (
        w.balance + COALESCE((
          SELECT SUM(p."unrealizedPnl")
          FROM "PaperPosition" p
          WHERE p."userId" = w."userId"
            AND p.status IN ('OPEN', 'PARTIALLY_CLOSED')
        ), 0)
      )
    ),
    "updatedAt" = NOW()
WHERE EXISTS (
  SELECT 1 FROM _equity e WHERE e.user_id = w."userId" AND e.equity > 0
);

-- ── Verification ─────────────────────────────────────────────────────────────
SELECT
  w."userId",
  w.balance                                                  AS new_balance,
  w."usedMargin"                                             AS new_used_margin,
  COALESCE((SELECT SUM(p."marginUsed") FROM "PaperPosition" p
            WHERE p."userId" = w."userId"
              AND p.status IN ('OPEN','PARTIALLY_CLOSED')), 0)
                                                             AS sum_open_margin,
  (w.balance + COALESCE((SELECT SUM(p."unrealizedPnl") FROM "PaperPosition" p
                          WHERE p."userId" = w."userId"
                            AND p.status IN ('OPEN','PARTIALLY_CLOSED')), 0))
                                                             AS new_equity
FROM "PaperWallet" w
ORDER BY w."userId";

COMMIT;
