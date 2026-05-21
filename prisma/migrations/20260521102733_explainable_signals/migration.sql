-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('LONG', 'SHORT');

-- CreateEnum
CREATE TYPE "PositionStatus" AS ENUM ('OPEN', 'PARTIALLY_CLOSED', 'CLOSED', 'STOP_LOSS_HIT', 'TAKE_PROFIT_HIT', 'EXPIRED', 'LIQUIDATED');

-- CreateEnum
CREATE TYPE "CloseReason" AS ENUM ('MANUAL', 'STOP_LOSS', 'TAKE_PROFIT', 'EXPIRED', 'LIQUIDATED', 'AI_EXIT');

-- CreateEnum
CREATE TYPE "DecisionSource" AS ENUM ('MANUAL', 'RULE', 'LLM');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'FILLED', 'CANCELLED', 'REJECTED');

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT NOT NULL,
    "emailVerified" TIMESTAMP(3),
    "hashedPassword" TEXT,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaperWallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "balance" DECIMAL(20,8) NOT NULL DEFAULT 60000,
    "usedMargin" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USDT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaperWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaperPosition" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" "OrderSide" NOT NULL,
    "initialQuantity" DECIMAL(20,8) NOT NULL,
    "quantity" DECIMAL(20,8) NOT NULL,
    "entryPrice" DECIMAL(20,8) NOT NULL,
    "exitPrice" DECIMAL(20,8),
    "takeProfit" DECIMAL(20,8),
    "stopLoss" DECIMAL(20,8),
    "leverage" INTEGER NOT NULL DEFAULT 1,
    "marginUsed" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "liquidationPrice" DECIMAL(20,8),
    "walletBalanceSnapshot" DECIMAL(20,8),
    "realizedPnl" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "unrealizedPnl" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "totalFees" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "status" "PositionStatus" NOT NULL DEFAULT 'OPEN',
    "closeReason" "CloseReason",
    "decisionSource" "DecisionSource" NOT NULL DEFAULT 'MANUAL',
    "decisionMeta" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "PaperPosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaperOrder" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "orderType" "OrderType" NOT NULL,
    "side" "OrderSide" NOT NULL,
    "quantity" DECIMAL(20,8) NOT NULL,
    "price" DECIMAL(20,8),
    "filledPrice" DECIMAL(20,8),
    "takeProfit" DECIMAL(20,8),
    "stopLoss" DECIMAL(20,8),
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "decisionSource" "DecisionSource" NOT NULL DEFAULT 'MANUAL',
    "decisionMeta" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "filledAt" TIMESTAMP(3),

    CONSTRAINT "PaperOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeHistory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" "OrderSide" NOT NULL,
    "quantity" DECIMAL(20,8) NOT NULL,
    "entryPrice" DECIMAL(20,8) NOT NULL,
    "exitPrice" DECIMAL(20,8) NOT NULL,
    "pnl" DECIMAL(20,8) NOT NULL,
    "closeReason" "CloseReason" NOT NULL,
    "decisionSource" "DecisionSource" NOT NULL DEFAULT 'MANUAL',
    "openedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "durationMs" INTEGER NOT NULL,
    "riskReward" DOUBLE PRECISION,

    CONSTRAINT "TradeHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExplainableSignal" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL,
    "finalAction" TEXT NOT NULL,
    "executionResult" TEXT,
    "emaAlignment" TEXT NOT NULL,
    "rsi" DOUBLE PRECISION,
    "macd" JSONB,
    "vwap" DOUBLE PRECISION,
    "volatility" DOUBLE PRECISION,
    "trendRegime" TEXT NOT NULL,
    "supportPrice" DOUBLE PRECISION,
    "resistancePrice" DOUBLE PRECISION,
    "momentumAnalysis" TEXT,
    "candlestickPatterns" JSONB,
    "newsValidation" JSONB,
    "reasoning" JSONB,
    "slPrice" DOUBLE PRECISION,
    "tpPrice" DOUBLE PRECISION,
    "riskRewardRatio" DOUBLE PRECISION,
    "leverageAdjustment" TEXT,
    "sizeAdjustment" TEXT,
    "positionSizing" JSONB,
    "entryDrift" DOUBLE PRECISION,
    "spreadValidation" TEXT,
    "liquidityChecks" TEXT,
    "newsVetoResult" TEXT,

    CONSTRAINT "ExplainableSignal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "PaperWallet_userId_key" ON "PaperWallet"("userId");

-- CreateIndex
CREATE INDEX "PaperPosition_userId_status_idx" ON "PaperPosition"("userId", "status");

-- CreateIndex
CREATE INDEX "PaperPosition_symbol_idx" ON "PaperPosition"("symbol");

-- CreateIndex
CREATE INDEX "PaperOrder_userId_status_idx" ON "PaperOrder"("userId", "status");

-- CreateIndex
CREATE INDEX "PaperOrder_symbol_idx" ON "PaperOrder"("symbol");

-- CreateIndex
CREATE INDEX "TradeHistory_userId_closedAt_idx" ON "TradeHistory"("userId", "closedAt");

-- CreateIndex
CREATE INDEX "TradeHistory_symbol_idx" ON "TradeHistory"("symbol");

-- CreateIndex
CREATE INDEX "TradeHistory_positionId_idx" ON "TradeHistory"("positionId");

-- CreateIndex
CREATE INDEX "ExplainableSignal_symbol_idx" ON "ExplainableSignal"("symbol");

-- CreateIndex
CREATE INDEX "ExplainableSignal_timestamp_idx" ON "ExplainableSignal"("timestamp");

-- CreateIndex
CREATE INDEX "ExplainableSignal_status_idx" ON "ExplainableSignal"("status");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperWallet" ADD CONSTRAINT "PaperWallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperPosition" ADD CONSTRAINT "PaperPosition_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperOrder" ADD CONSTRAINT "PaperOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeHistory" ADD CONSTRAINT "TradeHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeHistory" ADD CONSTRAINT "TradeHistory_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "PaperPosition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
