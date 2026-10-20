# Verified test refunds and compensating credits

Implemented on 2026-10-20. This is a test-only continuation of
[BILLING_TEST_CHECKOUT.md](BILLING_TEST_CHECKOUT.md). Checkout/webhook defaults and
`PREPAID_GENERATION_ENABLED=false` are unchanged. No Telegram client logic is added.

## Scope and provider verification

An operator initiates a refund in the YooKassa test-shop dashboard. The backend does not expose
an endpoint that transfers money or call POST `/refunds` in this slice. It discovers existing
refunds through authenticated provider GET requests and compensates credits only after confirming
`status=succeeded`. Pending and canceled refunds are recorded without revoking credits.

The existing `/api/v1/payments/yookassa/webhook` accepts `refund.succeeded`. Its payload is an
untrusted hint: only the refund ID is used. The server fetches GET `/refunds/:id`, checks the exact
returned ID, then verifies the original payment using GET `/payments/:id`. Refund objects do not
contain shop/account or test fields, so those are verified on the original payment. The same exact
account, payment ID, order/attempt metadata, original paid amount, currency, succeeded/paid status
and `test=true` checks apply. A lost original fulfillment is recovered idempotently before refund
compensation. Refund amount must be a positive integer amount in minor currency units, use the
order currency, and not exceed the remaining successful-refund amount of that order.

Provider references checked on 2026-10-20:

- <https://yookassa.ru/developers/payment-acceptance/after-the-payment/refunds>
- <https://yookassa.ru/developers/using-api/webhooks>
- <https://yookassa.ru/developers/api/yookassa-openapi-specification.yaml>

Raw provider payloads, descriptions, card/contact data and credentials are not stored in audit
records or logs. Received notifications, verified states and rejections append immutable
PaymentEvents. Duplicate events and repeated polling never compensate twice. Final succeeded or
canceled refund rows cannot regress on stale provider responses; a contradictory canceled-to-
succeeded transition requires investigation.

## Explicit credit policy

This policy is implemented for test validation and must be reviewed before production rollout:

- A successful refund revokes credits from the original order through a new `REFUND` ledger entry.
  Ledger `units` remains a positive magnitude; `kind=REFUND` means a debit. Existing PURCHASE and
  reservation history are never edited or deleted.
- Partial refunds use cumulative proportional allocation:
  `floor(total successful refundedMinor * original units / original priceMinor)`.
  Each new refund revokes only the difference from already revoked units. Integer arithmetic uses
  BigInt, so money calculations do not depend on floating point precision. Processing order can
  change the units assigned to each individual refund, but never their cumulative total.
- Fractional credits carry forward. For a 20-credit / 99 RUB pack, a 0.01 RUB refund revokes zero
  credits; another 49.49 RUB makes the cumulative refund 49.50 RUB and revokes 10 credits. A final
  49.50 RUB revokes the other 10. Zero-unit refunds are recorded with compensatedAt but do not
  create zero-unit ledger entries. A full refund always revokes exactly the original pack units.
- Available credits are debited first. If some credits were spent or reserved, the shortage becomes
  `GenerationWallet.debt`; available/reserved/debt all remain nonnegative. Credits are fungible
  within the same user's credit type, so other available credits of that type can cover the debit.
- New credit reservations fail with the existing `INSUFFICIENT_TEXT_CREDITS` or
  `INSUFFICIENT_IMAGE_CREDITS` while that credit wallet has debt. Error details include debt.
- Every subsequent grant (including purchase/gift) first repays debt, then increases available.
  Replaying an old grant does neither again.
- Active reservations are not forcibly canceled. Commit consumes the already reserved credits and
  keeps debt. Release repays debt first, then restores any surplus to available. Repeated settlement
  is idempotent. Existing generated content is not deleted; delivery retries keep their old accounting.

Example: buy 20, spend 12, refund all 20 → available 0 / debt 12. Receive 5 new credits → debt 7.
Receive 10 more → debt 0 / available 3. Reserve 4 before a full refund → reserved 4 / debt 4;
release those 4 → reserved 0 / debt 0 / available 0.

Compensation, refund state, cumulative order totals and the verified audit event share one
serializable transaction. A crash after wallet/ledger writes rolls everything back. Unique refund
IDs and operation keys, plus transaction conflict retries, protect concurrent webhook/poll/reserve
operations. Recovery retries the same provider refund, never a money-transfer POST.

## Additive API contract

The bot contract is [billing.openapi.json](openapi/billing.openapi.json), version 1.1.0, referenced
by the main OpenAPI file. Runtime Swagger publishes the same response fields.

| Method | Relative to `/api/v1`                     | Behavior                                                                               |
| ------ | ----------------------------------------- | -------------------------------------------------------------------------------------- |
| GET    | `/purchase-orders/:orderId/refunds`       | Latest 100 local verified refund states; ownership required                            |
| POST   | `/purchase-orders/:orderId/refunds/check` | Discover/verify provider refunds and return the updated owned order; no money transfer |
| POST   | `/payments/yookassa/webhook`              | Adds `refund.succeeded`; existing payment events remain supported                      |

Existing browser session/CSRF and bot HMAC rules apply to owned endpoints. A foreign order returns
404 before any provider calls. The public webhook is still disabled unless
`YOOKASSA_WEBHOOK_ENABLED=true`; refund handling cannot enable live checkout.

Order responses add `refundStatus=NONE|PARTIAL|FULL`, `refundedMinor` and `refundedUnits`.
`status=PAID`, `paymentStatus=SUCCEEDED` and `fulfillmentStatus=FULFILLED` describe the original
successful payment/grant and remain unchanged after refunds. Clients must inspect refundStatus
separately. Wallet responses add nonnegative `debt` (zero for old rows).

Refund example:

```json
{
  "data": [
    {
      "id": "11111111-1111-4111-8111-111111111111",
      "providerRefundId": "22222222-2222-4222-8222-222222222222",
      "amountMinor": 4950,
      "currency": "RUB",
      "status": "SUCCEEDED",
      "compensatedUnits": 10,
      "compensatedAt": "2026-10-20T09:00:00.000Z",
      "createdAt": "2026-10-20T09:00:00.000Z"
    }
  ]
}
```

`createdAt` is the local observation time. Refund states: PENDING / SUCCEEDED / CANCELLED.
`compensatedAt=null` means no successful compensation yet; succeeded tiny partial refunds can have
`compensatedUnits=0` with a non-null compensatedAt.

Machine-readable errors use the existing envelope:

- `REFUND_VERIFICATION_FAILED` (409): ID/association/currency/amount/cumulative total mismatch.
- `REFUND_PAYMENT_NOT_CONFIRMED` (409): original provider payment is not succeeded/paid.
- `REFUND_RECONCILIATION_LIMIT` (409): repeated cursor or more than 10 pages for one order; already
  applied entries remain valid/idempotent, and an operator must investigate remaining IDs.
- Existing `PAYMENT_VERIFICATION_FAILED`, `PURCHASE_ORDER_NOT_FOUND`,
  `PAYMENT_PROVIDER_UNAVAILABLE`, `PAYMENT_PROVIDER_INVALID_RESPONSE`, `PAYMENT_NOT_CONFIRMED`,
  `PAYMENT_WEBHOOK_DISABLED` retain their semantics.

A transient provider failure returns non-200 to webhook and remains retryable. A verified permanent
mismatch is audited/rejected and acknowledged without compensating credits.

## Reconciliation and controlled test

```sh
npm run prisma:migrate:deploy
npm run generation-packs:provision
npm run build
npm run payments:reconcile
# Runtime container, credentials remain in backend environment:
docker exec autobot-api node dist/payment-reconcile.js
```

The CLI now checks payments first and refunds second. Existing top-level payment counters remain;
`refunds: { scanned, checked, failed }` is additive. A failed payment or refund candidate produces
nonzero exit status. Aggregate counts only are logged.

Refund reconciliation scans up to 100 paid order attempts per invocation. It uses provider
`GET /refunds?payment_id=...` pagination and independently fetches each returned refund. Pagination
never processes another order's refund. Orders rotate by `refundsCheckedAt`, the last reconciliation
attempt timestamp (including failures), so one failed order cannot starve all others. Repeated runs
cover more than 100 orders. There is no automatically started recurring refund job.

On an isolated test database/shop with an allowlisted test user:

1. Follow the existing controlled checkout procedure; confirm exactly one PURCHASE grant.
2. In the test-shop dashboard initiate a partial refund and register `refund.succeeded` notifications.
3. Call the owned refunds/check endpoint or run reconciliation; inspect PARTIAL, cumulative amount
   and the new REFUND debit. Repeat the same webhook/check and verify no duplicate debit.
4. Refund the remainder; verify FULL and the complete original pack-unit compensation.
5. Repeat after spending/reserving some credits and verify debt/commit/release policy above.
6. Keep the test database isolated. Review the credit-debt and rounding policies before production.

Automated verification mocks provider HTTP; it does not refund real money or contact the live shop.
Production channel approval/Telegram Stars and full generation/media rollout remain separate work.

## Migration and rollback

Migration: `20261020120000_refund_compensation` adds PaymentRefund/RefundStatus, cumulative order
counters, last refund reconciliation attempt time, and nonnegative wallet debt. All old rows receive
zero totals/debt. Existing routes/status enums are retained.

```sh
npm run openapi:billing:generate
npm run verify
```

The verification gate checks migrations, duplicate provisioning, refund concurrency/recovery,
roundtrip of the new schema in an isolated transaction, all existing unit/integration/acceptance
tests and both container images.

Before deployment keep a verified backup. Do not run a destructive down migration in production:
refund rows, aggregate totals and debt are financial state. Before any application rollback disable
new checkout and prepaid writes, drain in-flight work and reconcile. **Do not restore wallet code
that ignores debt once compensation has occurred.** Retain this refund-aware wallet implementation
or deploy a forward fix; otherwise old grants/releases can make revoked credits spendable again.
Keep all schema additions and immutable history. A test-only schema roundtrip is not a production
financial rollback procedure.

## Changed files

```text
docs/BILLING_REFUNDS.md
docs/BILLING_TEST_CHECKOUT.md
docs/DEPLOYMENT.md
docs/GENERATION_PACKS_IMPLEMENTATION.md
docs/openapi/billing.openapi.json
docs/openapi/openapi.yaml
prisma/migrations/20261020120000_refund_compensation/migration.sql
prisma/schema.prisma
scripts/export-billing-openapi.mjs
src/generation-packs/billing.openapi.ts
src/generation-packs/generation-packs.module.ts
src/generation-packs/payments.controller.ts
src/generation-packs/payments.service.ts
src/generation-packs/purchase.service.ts
src/generation-packs/refund-policy.spec.ts
src/generation-packs/refund-policy.ts
src/generation-packs/refunds.controller.ts
src/generation-packs/refunds.service.ts
src/generation-packs/wallet.service.spec.ts
src/generation-packs/wallet.service.ts
src/generation-packs/yookassa.adapter.ts
src/payment-reconcile.ts
test/payments.integration.spec.ts
```
