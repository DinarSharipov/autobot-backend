CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'CANCELLED');
ALTER TABLE "GenerationWallet" ADD COLUMN "debt" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "GenerationWallet_debt_check" CHECK ("debt" >= 0);
ALTER TABLE "PurchaseOrder"
  ADD COLUMN "refundedMinor" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "refundedUnits" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "refundsCheckedAt" TIMESTAMP(3),
  ADD CONSTRAINT "PurchaseOrder_refundedMinor_check" CHECK ("refundedMinor" >= 0 AND "refundedMinor" <= "priceMinor"),
  ADD CONSTRAINT "PurchaseOrder_refundedUnits_check" CHECK ("refundedUnits" >= 0 AND "refundedUnits" <= "units");
CREATE TABLE "PaymentRefund" (
  "id" UUID NOT NULL,
  "providerRefundId" UUID NOT NULL,
  "purchaseOrderId" UUID NOT NULL,
  "amountMinor" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "status" "RefundStatus" NOT NULL,
  "compensatedUnits" INTEGER NOT NULL DEFAULT 0,
  "compensatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PaymentRefund_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentRefund_amount_check" CHECK ("amountMinor" > 0),
  CONSTRAINT "PaymentRefund_units_check" CHECK ("compensatedUnits" >= 0),
  CONSTRAINT "PaymentRefund_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PaymentRefund_providerRefundId_key" ON "PaymentRefund"("providerRefundId");
CREATE INDEX "PaymentRefund_purchaseOrderId_createdAt_idx" ON "PaymentRefund"("purchaseOrderId", "createdAt");
CREATE INDEX "PaymentRefund_status_updatedAt_idx" ON "PaymentRefund"("status", "updatedAt");
