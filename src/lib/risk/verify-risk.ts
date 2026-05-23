import { computePositionRiskMetrics } from "./metrics";

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function runTests() {
  console.log("=== STARTING RISK ENGINE TESTS ===");

  // 1. LONG Position Test (Standard Size)
  // Entry: 50,000, Qty: 0.1, Leverage: 10, TP: 55,000, SL: 48,000, Current: 51,000
  const longMetrics = computePositionRiskMetrics({
    side: "LONG",
    entryPrice: 50000,
    quantity: 0.1,
    leverage: 10,
    takeProfitPrice: 55000,
    stopLossPrice: 48000,
    currentPrice: 51000,
    walletBalance: 10000,
  });

  console.log("Testing LONG Position:", longMetrics);
  assert(longMetrics.notionalValue === 5000, "LONG Notional");
  assert(longMetrics.marginUsed === 500, "LONG Margin");
  assert(longMetrics.projectedProfit === 500, "LONG Projected Profit"); // (55k - 50k) * 0.1 = 500
  assert(longMetrics.projectedLoss === 200, "LONG Projected Loss"); // (50k - 48k) * 0.1 = 200
  assert(longMetrics.riskRewardRatio === 2.5, "LONG RR"); // 500 / 200 = 2.5
  assert(longMetrics.unrealizedPnl === 100, "LONG PnL"); // (51k - 50k) * 0.1 = 100
  assert(longMetrics.unrealizedPnlPct === 20, "LONG ROE %"); // 100 / 500 * 100 = 20%
  assert(longMetrics.unrealizedPnlNotionalPct === 2, "LONG Notional PnL %"); // 100 / 5000 * 100 = 2%
  assert(longMetrics.riskPercentOfWallet === 2, "LONG Risk Wallet %"); // 200 / 10000 * 100 = 2%
  assert(longMetrics.liquidationPrice === 45000, "LONG Liq Price"); // 50000 - (50000 / 10) = 45000

  // 2. SHORT Position Test (Leveraged + Sized)
  // Entry: 75,402.33, Qty: 0.012, Leverage: 1, TP: 74,601.05, SL: 75,575.58, Current: 75,278.43
  const shortMetrics = computePositionRiskMetrics({
    side: "SHORT",
    entryPrice: 75402.33,
    quantity: 0.012,
    leverage: 1,
    takeProfitPrice: 74601.05,
    stopLossPrice: 75575.58,
    currentPrice: 75278.43,
  });

  console.log("Testing SHORT Position:", shortMetrics);
  const expectedProfit = (75402.33 - 74601.05) * 0.012; // 801.28 * 0.012 = 9.61536
  const expectedLoss = (75575.58 - 75402.33) * 0.012; // 173.25 * 0.012 = 2.079
  const expectedUnrealized = (75402.33 - 75278.43) * 0.012; // 123.9 * 0.012 = 1.4868
  
  assert(Math.abs(shortMetrics.projectedProfit - expectedProfit) < 1e-6, "SHORT Projected Profit");
  assert(Math.abs(shortMetrics.projectedLoss - expectedLoss) < 1e-6, "SHORT Projected Loss");
  assert(Math.abs(shortMetrics.riskRewardRatio - (expectedProfit / expectedLoss)) < 1e-6, "SHORT RR");
  assert(Math.abs(shortMetrics.unrealizedPnl - expectedUnrealized) < 1e-6, "SHORT Unrealized PnL");
  assert(shortMetrics.liquidationPrice === Number.POSITIVE_INFINITY, "SHORT Liq Price 1x");

  // 3. Edge Case: Tiny quantities and precision limits
  const tinyMetrics = computePositionRiskMetrics({
    side: "LONG",
    entryPrice: 1.05,
    quantity: 0.00000005,
    leverage: 50,
    takeProfitPrice: 2.10,
    stopLossPrice: 0.84,
  });
  console.log("Testing Tiny Position:", tinyMetrics);
  assert(tinyMetrics.notionalValue > 0, "Tiny Notional");
  assert(tinyMetrics.marginUsed > 0, "Tiny Margin");
  assert(Math.abs(tinyMetrics.riskRewardRatio - 5.0) < 1e-9, "Tiny RR");

  console.log("=== ALL RISK TESTS PASSED SUCCESSFULLY ===");
}

try {
  runTests();
} catch (e: any) {
  console.error("Test failure:", e.message);
  process.exit(1);
}
