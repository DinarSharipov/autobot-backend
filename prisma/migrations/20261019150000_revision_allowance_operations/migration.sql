-- Track included revision reservations separately from prepaid TEXT reservations.
CREATE TYPE "RevisionAllowanceOperationStatus" AS ENUM ('RESERVED', 'COMMITTED', 'RELEASED');

CREATE TABLE "TextRevisionAllowanceOperation" (
    "id" UUID NOT NULL,
    "allowanceId" UUID NOT NULL,
    "operationKey" TEXT NOT NULL,
    "status" "RevisionAllowanceOperationStatus" NOT NULL DEFAULT 'RESERVED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "TextRevisionAllowanceOperation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TextRevisionAllowanceOperation_operationKey_key"
    ON "TextRevisionAllowanceOperation"("operationKey");
CREATE INDEX "TextRevisionAllowanceOperation_allowanceId_status_idx"
    ON "TextRevisionAllowanceOperation"("allowanceId", "status");

ALTER TABLE "TextRevisionAllowanceOperation"
    ADD CONSTRAINT "TextRevisionAllowanceOperation_allowanceId_fkey"
    FOREIGN KEY ("allowanceId") REFERENCES "TextRevisionAllowance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
