#!/usr/bin/env node
/**
 * Read-only: lists every OPEN / PARTIALLY_CLOSED position on the target DB
 * (--db=neon or --db=local). Used as a pre-flight inspection before any
 * destructive maintenance script touches positions.
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

const prisma = new PrismaClient({ datasources: { db: { url } } });

const num = (d) => {
  if (d == null) return 0;
  if (typeof d === "number") return d;
  if (typeof d === "string") return Number(d);
  if (typeof d.toNumber === "function") return d.toNumber();
  return Number(d.toString());
};

async function main() {
  console.log(`▶ Reading from: ${target}`);
  const positions = await prisma.paperPosition.findMany({
    where: { status: { in: ["OPEN", "PARTIALLY_CLOSED"] } },
    orderBy: { createdAt: "asc" },
  });
  console.log(`▶ Found ${positions.length} open/partial position(s):`);
  for (const p of positions) {
    console.log(
      `   • id=${p.id} user=${p.userId.slice(0, 8)}… ${p.side} ${p.symbol} ` +
        `qty=${num(p.quantity)} entry=${num(p.entryPrice)} ` +
        `SL=${p.stopLoss ? num(p.stopLoss) : "—"} TP=${p.takeProfit ? num(p.takeProfit) : "—"} ` +
        `margin=${num(p.marginUsed)} status=${p.status} ` +
        `source=${p.decisionSource} opened=${p.createdAt.toISOString()}`,
    );
  }
  const wallets = await prisma.paperWallet.findMany();
  console.log(`▶ Wallets:`);
  for (const w of wallets) {
    console.log(
      `   • user=${w.userId.slice(0, 8)}…  balance=${num(w.balance)}  usedMargin=${num(w.usedMargin)}`,
    );
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  prisma.$disconnect().finally(() => process.exit(1));
});
