-- AlterEnum
ALTER TYPE "CloseReason" ADD VALUE 'AI_EARLY_EXIT';

-- AlterTable
ALTER TABLE "PaperPosition" ADD COLUMN     "managementMeta" JSONB,
ADD COLUMN     "originalStopLoss" DECIMAL(20,8),
ADD COLUMN     "originalTakeProfit" DECIMAL(20,8),
ADD COLUMN     "tradeHealthScore" INTEGER;

-- CreateTable
CREATE TABLE "TradeManagementEvent" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "oldValue" DOUBLE PRECISION,
    "newValue" DOUBLE PRECISION,
    "healthScore" INTEGER NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "indicators" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradeManagementEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TradeManagementEvent_positionId_createdAt_idx" ON "TradeManagementEvent"("positionId", "createdAt");

-- AddForeignKey
ALTER TABLE "TradeManagementEvent" ADD CONSTRAINT "TradeManagementEvent_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "PaperPosition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
