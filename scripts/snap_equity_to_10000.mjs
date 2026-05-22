#!/usr/bin/env node
/**
 * snap_equity_to_10000.mjs
 *
 * Re-fetches live Binance marks for every OPEN / PARTIALLY_CLOSED position,
 * computes each user's live unrealizedPnL the same way the UI does
 * (`(mark - entry) * qty * direction`), then nudges `PaperWallet.balance`
 * so that
 *
 *     totalEquity = walletBalance + Σ unrealizedPnl  →  $10,000.00
 *
 * for every user, RIGHT NOW.
 *
 * What this preserves (untouched):
 *   - entry, exit, TP, SL, originalTakeProfit/StopLoss, liquidationPrice,
 *     leverage, riskReward — i.e. all market structure
 *   - quantities, marginUsed, realizedPnl on positions
 *   - all TradeHistory rows (closed-trade pnl + percentage returns)
 *   - all TradeManagementEvent / ExplainableSignal analytics
 *   - usedMargin on wallet
 *
 * What this changes:
 *   - PaperWallet.balance per user (so live equity == 10000 at this tick)
 *   - PaperPosition.unrealizedPnl snapshot for open positions (cosmetic; the
 *     UI recomputes live anyway, but keeps the stored snapshot honest).
 *
 * Connects to EITHER local OR Neon based on the --db flag:
 *   node scripts/snap_equity_to_10000.mjs --db=local
 *   node scripts/snap_equity_to_10000.mjs --db=neon
 */

import process from "node:process";
import { PrismaClient } from "@prisma/client";

const TARGET_EQUITY = 10_000;

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);

const target = args.db === "neon" ? "NEON_URL" : "DATABASE_URL";
const url = process.env[target];
if (!url) {
  console.error(`Missing env var ${target}. Run via:  source <(grep -v '^#' .env | xargs -I{} echo export {})`);
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url } } });

async function fetchMark(symbol) {
  const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`);
  if (!res.ok) throw new Error(`Binance ${res.status} for ${symbol}`);
  const json = await res.json();
  return Number(json.price);
}

function toNum(d) {
  // Prisma Decimal → Number (Decimal has .toNumber() and .toString())
  if (d == null) return 0;
  if (typeof d === "number") return d;
  if (typeof d === "string") return Number(d);
  if (typeof d.toNumber === "function") return d.toNumber();
  return Number(d.toString());
}

async function main() {
  console.log(`▶ Target DB: ${target}`);
  console.log(`▶ Target equity per user: $${TARGET_EQUITY.toLocaleString()}`);

  const wallets = await prisma.paperWallet.findMany();
  console.log(`▶ Found ${wallets.length} wallet(s).`);

  for (const w of wallets) {
    const open = await prisma.paperPosition.findMany({
      where: { userId: w.userId, status: { in: ["OPEN", "PARTIALLY_CLOSED"] } },
    });

    let liveUnreal = 0;
    const perPosUpdate = [];
    for (const p of open) {
      const mark = await fetchMark(p.symbol);
      const direction = p.side === "LONG" ? 1 : -1;
      const u = (mark - toNum(p.entryPrice)) * toNum(p.quantity) * direction;
      liveUnreal += u;
      perPosUpdate.push({ id: p.id, symbol: p.symbol, mark, unreal: u });
      console.log(
        `   • ${p.symbol} ${p.side} qty=${toNum(p.quantity)} entry=${toNum(p.entryPrice)} mark=${mark} → unreal=${u.toFixed(6)}`,
      );
    }

    const oldBalance = toNum(w.balance);
    const liveEquity = oldBalance + liveUnreal;
    const newBalance = TARGET_EQUITY - liveUnreal; // so newBalance + liveUnreal = TARGET_EQUITY
    const delta = newBalance - oldBalance;
    console.log(
      `   wallet ${w.userId.slice(0, 8)}…  balance=${oldBalance.toFixed(8)}  liveUnreal=${liveUnreal.toFixed(8)}  liveEquity=${liveEquity.toFixed(8)}  →  newBalance=${newBalance.toFixed(8)}  (Δ ${delta.toFixed(8)})`,
    );

    await prisma.$transaction(async (tx) => {
      await tx.paperWallet.update({
        where: { id: w.id },
        data: { balance: newBalance.toFixed(8) },
      });
      for (const pu of perPosUpdate) {
        await tx.paperPosition.update({
          where: { id: pu.id },
          data: { unrealizedPnl: pu.unreal.toFixed(8) },
        });
      }
    });

    // Verify
    const verifyW = await prisma.paperWallet.findUnique({ where: { id: w.id } });
    const verifyOpen = await prisma.paperPosition.findMany({
      where: { userId: w.userId, status: { in: ["OPEN", "PARTIALLY_CLOSED"] } },
    });
    let storedUnreal = 0;
    for (const p of verifyOpen) storedUnreal += toNum(p.unrealizedPnl);
    const storedEquity = toNum(verifyW.balance) + storedUnreal;
    console.log(
      `   ✓ stored: balance=${toNum(verifyW.balance).toFixed(8)}  Σunreal=${storedUnreal.toFixed(8)}  equity=${storedEquity.toFixed(8)}`,
    );
  }

  await prisma.$disconnect();
  console.log("done.");
}

main().catch((e) => {
  console.error(e);
  prisma.$disconnect().finally(() => process.exit(1));
});
