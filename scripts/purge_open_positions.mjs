#!/usr/bin/env node
/**
 * purge_open_positions.mjs
 *
 * Hard-removes every OPEN / PARTIALLY_CLOSED position from the target DB
 * WITHOUT realizing any P&L. For each position, in a single transaction:
 *
 *   1. Release the reserved margin back to the wallet:
 *        PaperWallet.usedMargin -= position.marginUsed
 *   2. Delete the PaperPosition row. Cascade deletes:
 *        - TradeManagementEvent rows for this positionId
 *        - TradeHistory rows for this positionId (only present for positions
 *          that had a prior partial close — those P&L impacts on the wallet
 *          balance happened at the time of the partial and are NOT reversed
 *          here. Use --dry-run to inspect first.)
 *
 * Wallet `balance` is NEVER touched — this script intentionally does not
 * record profit or loss for the removed open quantity.
 *
 * Usage:
 *   node scripts/purge_open_positions.mjs --db=neon --dry-run
 *   node scripts/purge_open_positions.mjs --db=neon --confirm
 *
 * Refuses to run against --db=neon without --confirm.
 */
import process from "node:process";
import { PrismaClient } from "@prisma/client";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);

const target = args.db === "neon" ? "NEON_URL" : "DATABASE_URL";
const url = process.env[target];
if (!url) {
  console.error(`Missing env var ${target}.`);
  process.exit(1);
}
if (args.db === "neon" && !args.confirm && !args["dry-run"]) {
  console.error("Refusing to mutate Neon without --confirm or --dry-run.");
  process.exit(2);
}

const dryRun = !!args["dry-run"];
const prisma = new PrismaClient({ datasources: { db: { url } } });

const num = (d) => {
  if (d == null) return 0;
  if (typeof d === "number") return d;
  if (typeof d === "string") return Number(d);
  if (typeof d.toNumber === "function") return d.toNumber();
  return Number(d.toString());
};

async function main() {
  console.log(`▶ Target DB: ${target}`);
  console.log(`▶ Mode: ${dryRun ? "DRY RUN (no writes)" : "EXECUTE"}`);

  const positions = await prisma.paperPosition.findMany({
    where: { status: { in: ["OPEN", "PARTIALLY_CLOSED"] } },
    orderBy: { createdAt: "asc" },
  });
  console.log(`▶ Found ${positions.length} open/partial position(s) to remove.`);

  for (const p of positions) {
    const events = await prisma.tradeManagementEvent.count({
      where: { positionId: p.id },
    });
    const history = await prisma.tradeHistory.count({
      where: { positionId: p.id },
    });
    console.log(
      `   • id=${p.id} ${p.side} ${p.symbol} qty=${num(p.quantity)} ` +
        `margin=${num(p.marginUsed)} status=${p.status} ` +
        `→ will cascade-delete ${events} mgmt event(s), ${history} history row(s)`,
    );

    if (dryRun) continue;

    await prisma.$transaction(async (tx) => {
      await tx.paperWallet.update({
        where: { userId: p.userId },
        data: { usedMargin: { decrement: num(p.marginUsed) } },
      });
      await tx.paperPosition.delete({ where: { id: p.id } });
    });
    console.log(`     ✓ removed; margin $${num(p.marginUsed).toFixed(8)} released to user ${p.userId.slice(0, 8)}…`);
  }

  console.log(`▶ Post-state wallets:`);
  const wallets = await prisma.paperWallet.findMany();
  for (const w of wallets) {
    console.log(
      `   • user=${w.userId.slice(0, 8)}…  balance=${num(w.balance)}  usedMargin=${num(w.usedMargin)}`,
    );
  }

  await prisma.$disconnect();
  console.log("done.");
}

main().catch((e) => {
  console.error(e);
  prisma.$disconnect().finally(() => process.exit(1));
});
