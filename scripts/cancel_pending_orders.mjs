#!/usr/bin/env node
/**
 * Cancels every PENDING PaperOrder on the target DB. Used when stale
 * orders have accumulated due to a fill-path bug and would otherwise
 * fill at current market prices on the next matching-loop tick.
 *
 *   node scripts/cancel_pending_orders.mjs --db=neon --dry-run
 *   node scripts/cancel_pending_orders.mjs --db=neon --confirm
 *
 * Refuses to mutate Neon without --confirm.
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

  const pending = await prisma.paperOrder.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
  });
  console.log(`▶ Found ${pending.length} PENDING order(s):`);
  for (const o of pending) {
    console.log(
      `   • id=${o.id} user=${o.userId.slice(0, 8)}… ${o.side} ${o.orderType} ${o.symbol} ` +
        `qty=${num(o.quantity)} price=${o.price ? num(o.price) : "MKT"} ` +
        `SL=${o.stopLoss ? num(o.stopLoss) : "—"} TP=${o.takeProfit ? num(o.takeProfit) : "—"} ` +
        `source=${o.decisionSource} created=${o.createdAt.toISOString()}`,
    );
  }
  if (dryRun || pending.length === 0) {
    await prisma.$disconnect();
    return;
  }

  const result = await prisma.paperOrder.updateMany({
    where: { status: "PENDING" },
    data: { status: "CANCELLED" },
  });
  console.log(`▶ Cancelled ${result.count} PENDING order(s).`);

  await prisma.$disconnect();
  console.log("done.");
}

main().catch((e) => {
  console.error(e);
  prisma.$disconnect().finally(() => process.exit(1));
});
