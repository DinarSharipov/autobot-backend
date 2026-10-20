CREATE TYPE "CreditFulfillmentStatus" AS ENUM ('PENDING', 'FULFILLED');
ALTER TABLE "PurchaseOrder"
  ADD COLUMN "paymentIdempotencyKey" UUID,
  ADD COLUMN "paymentStartedAt" TIMESTAMP(3),
  ADD COLUMN "paymentReturnUrl" TEXT,
  ADD COLUMN "fulfillmentStatus" "CreditFulfillmentStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "fulfilledAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "PurchaseOrder_paymentIdempotencyKey_key" ON "PurchaseOrder"("paymentIdempotencyKey");

-- Events are immutable facts. Verification appends a new event instead of
-- rewriting a received event. TRUNCATE remains available for isolated tests.
CREATE FUNCTION reject_payment_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'PaymentEvent is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER payment_event_append_only
BEFORE UPDATE OR DELETE ON "PaymentEvent"
FOR EACH ROW EXECUTE FUNCTION reject_payment_event_mutation();
