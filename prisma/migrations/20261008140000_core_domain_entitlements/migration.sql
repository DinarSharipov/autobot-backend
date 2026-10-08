-- Usage operation keys are scoped to a monthly counter so independent users and periods
-- may reuse provider/job identifiers safely.
DROP INDEX "UsageLedgerEntry_operationKey_key";

CREATE TABLE "IdempotencyRecord" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseBody" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");
CREATE UNIQUE INDEX "IdempotencyRecord_userId_operation_key_key"
    ON "IdempotencyRecord"("userId", "operation", "key");
CREATE UNIQUE INDEX "UsageLedgerEntry_counterId_operationKey_key"
    ON "UsageLedgerEntry"("counterId", "operationKey");

ALTER TABLE "IdempotencyRecord"
    ADD CONSTRAINT "IdempotencyRecord_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
