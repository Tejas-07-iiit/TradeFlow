import { PrismaClient } from "@prisma/client";
import process from "node:process";
import dotenv from "dotenv";

dotenv.config();

const url = process.env.DATABASE_URL;
console.log("Using Database URL:", url);

const prisma = new PrismaClient({ datasources: { db: { url } } });

const num = (d) => {
  if (d == null) return 0;
  if (typeof d === "number") return d;
  if (typeof d === "string") return Number(d);
  if (typeof d.toNumber === "function") return d.toNumber();
  return Number(d.toString());
};

async function main() {
  // Let's get total trade count from TradeHistory
  const totalTrades = await prisma.tradeHistory.count();
  console.log(`Total trades in TradeHistory: ${totalTrades}`);

  const history = await prisma.tradeHistory.findMany({
    orderBy: { closedAt: "asc" }
  });

  let grossProfit = 0;
  let grossLoss = 0;
  let winCount = 0;
  let lossCount = 0;
  const reasonBreakdown = {};
  const symbolBreakdown = {};

  for (const t of history) {
    const pnl = num(t.pnl);
    if (pnl > 0) {
      grossProfit += pnl;
      winCount++;
    } else {
      grossLoss += Math.abs(pnl);
      lossCount++;
    }

    reasonBreakdown[t.closeReason] = (reasonBreakdown[t.closeReason] || 0) + 1;
    symbolBreakdown[t.symbol] = symbolBreakdown[t.symbol] || { pnl: 0, count: 0, wins: 0 };
    symbolBreakdown[t.symbol].pnl += pnl;
    symbolBreakdown[t.symbol].count++;
    if (pnl > 0) symbolBreakdown[t.symbol].wins++;
  }

  const netPnL = grossProfit - grossLoss;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit;

  console.log(`\n=== GENERAL STATISTICS ===`);
  console.log(`Net PnL: ${netPnL.toFixed(4)} USDT`);
  console.log(`Gross Profit: ${grossProfit.toFixed(4)} USDT`);
  console.log(`Gross Loss: ${grossLoss.toFixed(4)} USDT`);
  console.log(`Profit Factor: ${profitFactor.toFixed(4)}`);
  console.log(`Win Rate: ${winCount} / ${totalTrades} (${(totalTrades > 0 ? (winCount / totalTrades) * 100 : 0).toFixed(2)}%)`);
  console.log(`Avg Win: ${winCount > 0 ? (grossProfit / winCount).toFixed(4) : 0} USDT`);
  console.log(`Avg Loss: ${lossCount > 0 ? (grossLoss / lossCount).toFixed(4) : 0} USDT`);

  console.log(`\n=== CLOSE REASON BREAKDOWN ===`);
  const reasonStats = {};
  for (const t of history) {
    const pnl = num(t.pnl);
    reasonStats[t.closeReason] = reasonStats[t.closeReason] || { count: 0, pnl: 0, wins: 0 };
    reasonStats[t.closeReason].count++;
    reasonStats[t.closeReason].pnl += pnl;
    if (pnl > 0) reasonStats[t.closeReason].wins++;
  }
  for (const reason in reasonStats) {
    const data = reasonStats[reason];
    console.log(`${reason}: Count = ${data.count}, Net PnL = ${data.pnl.toFixed(4)} USDT, Avg PnL = ${(data.pnl / data.count).toFixed(4)} USDT, WinRate = ${(data.wins / data.count * 100).toFixed(2)}%`);
  }

  console.log(`\n=== SYMBOL BREAKDOWN ===`);
  for (const sym in symbolBreakdown) {
    const data = symbolBreakdown[sym];
    console.log(`${sym}: PnL = ${data.pnl.toFixed(4)} USDT, Count = ${data.count}, WinRate = ${(data.wins / data.count * 100).toFixed(2)}%`);
  }

  // Let's join with ExplainableSignal to see regime performance if possible
  console.log(`\n=== EXPLAINABLE SIGNALS ANALYSIS ===`);
  const signals = await prisma.explainableSignal.findMany({
    orderBy: { timestamp: "desc" },
    take: 100
  });
  console.log(`Recent signals stored: ${signals.length}`);
  const statusCounts = {};
  for (const s of signals) {
    statusCounts[s.status] = (statusCounts[s.status] || 0) + 1;
  }
  console.log("Recent status counts:", statusCounts);

  // Let's query positions as well
  const positions = await prisma.paperPosition.findMany({
    orderBy: { createdAt: "desc" }
  });
  console.log(`\nTotal positions in PaperPosition: ${positions.length}`);
  const posStatus = {};
  for (const p of positions) {
    posStatus[p.status] = (posStatus[p.status] || 0) + 1;
  }
  console.log("Position status breakdown:", posStatus);
}

main()
  .catch((e) => {
    console.error(e);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
