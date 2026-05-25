import { PrismaClient } from "@prisma/client";
import process from "node:process";

const url = process.env.NEON_URL;
if (!url) {
  console.error("Missing env var NEON_URL.");
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
  const userId = "cmpdpgel10000qk7y1v25elze"; // tejas23106@gmail.com
  
  console.log("=== POSITIONS CLOSED TODAY (MAY 25, 2026) ===");
  const positions = await prisma.paperPosition.findMany({
    where: {
      userId,
      closedAt: { gte: new Date("2026-05-25T00:00:00Z") }
    },
    orderBy: { closedAt: "desc" }
  });
  
  for (const p of positions) {
    console.log(`PosID: ${p.id}, Symbol: ${p.symbol}, Side: ${p.side}, Qty: ${num(p.quantity)}, Entry: ${num(p.entryPrice)}, Exit: ${num(p.exitPrice)}, RealizedPnL: ${num(p.realizedPnl)}, Status: ${p.status}, Reason: ${p.closeReason}, CreatedAt: ${p.createdAt.toISOString()}, ClosedAt: ${p.closedAt?.toISOString()}`);
  }
  
  console.log("\n=== TRADE HISTORY ENTRIES TODAY ===");
  const history = await prisma.tradeHistory.findMany({
    where: {
      userId,
      closedAt: { gte: new Date("2026-05-25T00:00:00Z") }
    },
    orderBy: { closedAt: "desc" }
  });
  
  for (const h of history) {
    console.log(`HistID: ${h.id}, PosID: ${h.positionId}, Symbol: ${h.symbol}, Side: ${h.side}, Qty: ${num(h.quantity)}, Entry: ${num(h.entryPrice)}, Exit: ${num(h.exitPrice)}, PnL: ${num(h.pnl)}, Reason: ${h.closeReason}, ClosedAt: ${h.closedAt.toISOString()}`);
  }
  
  await prisma.$disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
