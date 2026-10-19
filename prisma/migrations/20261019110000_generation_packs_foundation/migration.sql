-- Additive foundation for prepaid generation packs. Legacy subscription and
-- monthly usage data deliberately remain untouched during the cutover period.
CREATE TYPE "CreditType" AS ENUM ('TEXT', 'IMAGE');
CREATE TYPE "CreditLedgerKind" AS ENUM ('GIFT', 'PURCHASE', 'RESERVE', 'COMMIT', 'RELEASE', 'REFUND', 'ADJUSTMENT');
CREATE TYPE "ReservationStatus" AS ENUM ('RESERVED', 'COMMITTED', 'RELEASED');
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('PENDING', 'AWAITING_PAYMENT', 'PAID', 'CANCELLED', 'EXPIRED', 'FAILED');
CREATE TYPE "PaymentEventStatus" AS ENUM ('RECEIVED', 'VERIFIED', 'REJECTED', 'PROCESSED');
CREATE TYPE "MediaStatus" AS ENUM ('PENDING', 'READY', 'SELECTED', 'REJECTED', 'UNAVAILABLE');
CREATE TYPE "GenerationFundingStatus" AS ENUM ('READY', 'BLOCKED_FUNDS');

ALTER TABLE "Publication"
    ADD COLUMN "fundingStatus" "GenerationFundingStatus" NOT NULL DEFAULT 'READY',
    ADD COLUMN "selectedMediaId" UUID,
    ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "GenerationWallet" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "creditType" "CreditType" NOT NULL,
    "available" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GenerationWallet_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GenerationWallet_available_check" CHECK ("available" >= 0),
    CONSTRAINT "GenerationWallet_reserved_check" CHECK ("reserved" >= 0)
);

CREATE TABLE "GenerationPack" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "creditType" "CreditType" NOT NULL,
    "units" INTEGER NOT NULL,
    "priceMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "version" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GenerationPack_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GenerationPack_units_check" CHECK ("units" > 0),
    CONSTRAINT "GenerationPack_priceMinor_check" CHECK ("priceMinor" >= 0)
);

CREATE TABLE "PurchaseOrder" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "packId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'PENDING',
    "creditType" "CreditType" NOT NULL,
    "units" INTEGER NOT NULL,
    "priceMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "packVersion" INTEGER NOT NULL,
    "provider" TEXT,
    "providerOrderId" TEXT,
    "paymentUrl" TEXT,
    "expiresAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PurchaseOrder_units_check" CHECK ("units" > 0),
    CONSTRAINT "PurchaseOrder_priceMinor_check" CHECK ("priceMinor" >= 0)
);

CREATE TABLE "GenerationReservation" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "creditType" "CreditType" NOT NULL,
    "units" INTEGER NOT NULL,
    "operationKey" TEXT NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'RESERVED',
    "publicationId" UUID,
    "aiRequestId" UUID,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    CONSTRAINT "GenerationReservation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GenerationReservation_units_check" CHECK ("units" > 0)
);

CREATE TABLE "CreditLedgerEntry" (
    "id" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "kind" "CreditLedgerKind" NOT NULL,
    "units" INTEGER NOT NULL,
    "operationKey" TEXT NOT NULL,
    "reservationId" UUID,
    "publicationId" UUID,
    "purchaseOrderId" UUID,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CreditLedgerEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CreditLedgerEntry_units_check" CHECK ("units" > 0)
);

CREATE TABLE "TextRevisionAllowance" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "publicationId" UUID NOT NULL,
    "includedTotal" INTEGER NOT NULL DEFAULT 3,
    "includedCommitted" INTEGER NOT NULL DEFAULT 0,
    "includedReserved" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TextRevisionAllowance_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TextRevisionAllowance_total_check" CHECK ("includedTotal" >= 0),
    CONSTRAINT "TextRevisionAllowance_committed_check" CHECK ("includedCommitted" >= 0),
    CONSTRAINT "TextRevisionAllowance_reserved_check" CHECK ("includedReserved" >= 0),
    CONSTRAINT "TextRevisionAllowance_consumption_check" CHECK ("includedCommitted" + "includedReserved" <= "includedTotal")
);

CREATE TABLE "PaymentEvent" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "purchaseOrderId" UUID,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "status" "PaymentEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PublicationMedia" (
    "id" UUID NOT NULL,
    "publicationId" UUID NOT NULL,
    "status" "MediaStatus" NOT NULL DEFAULT 'PENDING',
    "telegramChatId" BIGINT,
    "telegramMessageId" BIGINT,
    "telegramFileId" TEXT,
    "telegramFileUniqueId" TEXT,
    "generationOperationKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "approvedAt" TIMESTAMP(3),
    CONSTRAINT "PublicationMedia_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Publication_selectedMediaId_key" ON "Publication"("selectedMediaId");
CREATE UNIQUE INDEX "GenerationWallet_userId_creditType_key" ON "GenerationWallet"("userId", "creditType");
CREATE INDEX "GenerationWallet_userId_idx" ON "GenerationWallet"("userId");
CREATE UNIQUE INDEX "GenerationPack_code_key" ON "GenerationPack"("code");
CREATE INDEX "GenerationPack_creditType_isActive_idx" ON "GenerationPack"("creditType", "isActive");
CREATE UNIQUE INDEX "PurchaseOrder_providerOrderId_key" ON "PurchaseOrder"("providerOrderId");
CREATE UNIQUE INDEX "PurchaseOrder_userId_idempotencyKey_key" ON "PurchaseOrder"("userId", "idempotencyKey");
CREATE INDEX "PurchaseOrder_userId_status_createdAt_idx" ON "PurchaseOrder"("userId", "status", "createdAt");
CREATE UNIQUE INDEX "GenerationReservation_operationKey_key" ON "GenerationReservation"("operationKey");
CREATE UNIQUE INDEX "GenerationReservation_aiRequestId_key" ON "GenerationReservation"("aiRequestId");
CREATE INDEX "GenerationReservation_userId_status_createdAt_idx" ON "GenerationReservation"("userId", "status", "createdAt");
CREATE INDEX "GenerationReservation_publicationId_status_idx" ON "GenerationReservation"("publicationId", "status");
CREATE INDEX "CreditLedgerEntry_reservationId_idx" ON "CreditLedgerEntry"("reservationId");
CREATE UNIQUE INDEX "CreditLedgerEntry_walletId_operationKey_key" ON "CreditLedgerEntry"("walletId", "operationKey");
CREATE INDEX "CreditLedgerEntry_walletId_createdAt_idx" ON "CreditLedgerEntry"("walletId", "createdAt");
CREATE INDEX "CreditLedgerEntry_publicationId_createdAt_idx" ON "CreditLedgerEntry"("publicationId", "createdAt");
CREATE INDEX "CreditLedgerEntry_purchaseOrderId_idx" ON "CreditLedgerEntry"("purchaseOrderId");
CREATE UNIQUE INDEX "TextRevisionAllowance_publicationId_key" ON "TextRevisionAllowance"("publicationId");
CREATE INDEX "TextRevisionAllowance_userId_createdAt_idx" ON "TextRevisionAllowance"("userId", "createdAt");
CREATE UNIQUE INDEX "PaymentEvent_provider_providerEventId_key" ON "PaymentEvent"("provider", "providerEventId");
CREATE INDEX "PaymentEvent_purchaseOrderId_createdAt_idx" ON "PaymentEvent"("purchaseOrderId", "createdAt");
CREATE UNIQUE INDEX "PublicationMedia_generationOperationKey_key" ON "PublicationMedia"("generationOperationKey");
CREATE UNIQUE INDEX "PublicationMedia_telegramChatId_telegramMessageId_key" ON "PublicationMedia"("telegramChatId", "telegramMessageId");
CREATE INDEX "PublicationMedia_publicationId_status_createdAt_idx" ON "PublicationMedia"("publicationId", "status", "createdAt");

ALTER TABLE "GenerationWallet" ADD CONSTRAINT "GenerationWallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_packId_fkey" FOREIGN KEY ("packId") REFERENCES "GenerationPack"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GenerationReservation" ADD CONSTRAINT "GenerationReservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GenerationReservation" ADD CONSTRAINT "GenerationReservation_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "GenerationWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GenerationReservation" ADD CONSTRAINT "GenerationReservation_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "Publication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GenerationReservation" ADD CONSTRAINT "GenerationReservation_aiRequestId_fkey" FOREIGN KEY ("aiRequestId") REFERENCES "AIRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreditLedgerEntry" ADD CONSTRAINT "CreditLedgerEntry_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "GenerationWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreditLedgerEntry" ADD CONSTRAINT "CreditLedgerEntry_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "GenerationReservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreditLedgerEntry" ADD CONSTRAINT "CreditLedgerEntry_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "Publication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreditLedgerEntry" ADD CONSTRAINT "CreditLedgerEntry_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TextRevisionAllowance" ADD CONSTRAINT "TextRevisionAllowance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TextRevisionAllowance" ADD CONSTRAINT "TextRevisionAllowance_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "Publication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PublicationMedia" ADD CONSTRAINT "PublicationMedia_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "Publication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Publication" ADD CONSTRAINT "Publication_selectedMediaId_fkey" FOREIGN KEY ("selectedMediaId") REFERENCES "PublicationMedia"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
