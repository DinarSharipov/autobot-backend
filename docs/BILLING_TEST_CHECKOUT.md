# Prepaid test checkout: bot contract and rollout

Status: implemented test-payment slice, disabled by default. No Telegram bot code is changed.
The production generation flag remains `PREPAID_GENERATION_ENABLED=false`.

## Payment channel decision

YooKassa redirect is implemented **for isolated testing only**. Every authoritative provider object
must have `test=true`; live payments are rejected, including webhook and polling paths.
For digital goods/services sold inside Telegram, the production design must use Telegram Stars
unless a separately reviewed product channel is outside that scope. A redirect to external checkout
is not approval to bypass Telegram rules. Stars integration and production rollout remain pending.

References checked on 2026-10-20:

- <https://core.telegram.org/bots/payments-stars>
- <https://yookassa.ru/developers/using-api/interaction-format>
- <https://yookassa.ru/developers/using-api/webhooks>

## Stable additive contract

The machine-readable contract is [billing.openapi.json](openapi/billing.openapi.json), version 1.0.0.
The main [OpenAPI document](openapi/openapi.yaml) references all billing paths. The running backend
publishes concrete schemas at `/api/docs-json` and Swagger UI at `/api/docs`.

| Method | Path relative to `/api/v1`                | Authentication / behavior                                               |
| ------ | ----------------------------------------- | ----------------------------------------------------------------------- |
| GET    | `/generation-packs`                       | Authenticated; optional `creditType=TEXT                                | IMAGE`; backend prices in kopecks |
| GET    | `/wallets`                                | Owned balances; ensures 3 TEXT + 1 IMAGE gift exactly once              |
| GET    | `/wallets/ledger`                         | Owned ledger; optional creditType, limit 1–100, default 50              |
| POST   | `/purchase-orders`                        | Owned order; body `{ "packCode": "text-20" }`; required Idempotency-Key |
| GET    | `/purchase-orders`                        | Latest 100 owned orders                                                 |
| GET    | `/purchase-orders/:orderId`               | Owned snapshot; never queries provider or grants credits                |
| POST   | `/purchase-orders/:orderId/payment`       | Creates/replays one test-payment attempt; no client price               |
| POST   | `/purchase-orders/:orderId/payment/check` | Server GET verification; may fulfill a succeeded test payment           |
| POST   | `/payments/yookassa/webhook`              | Public provider notification; never trusts notification status/amount   |

Bot authentication is the existing HMAC protocol including Telegram user ID and a fresh nonce per
HTTP request. Browser mutations require a valid session and CSRF. Requests for another user's order
return 404. Only order creation needs a client Idempotency-Key; payment creation uses a backend UUID
persisted on that order. Reusing the order always reuses the provider key. A separate order is needed
for a genuinely new purchase.

`status` is retained for compatibility. New clients use `paymentStatus` and `fulfillmentStatus`
separately. `paymentUrl` remains as a deprecated alias of `confirmationUrl`. `expiresAt` is nullable:
YooKassa does not supply an expiry for every payment; the backend does not invent one.
A successful HTTP check may still report `paymentStatus=PENDING`; the bot must inspect the status.

Catalogue example:

```json
{
  "data": [
    {
      "code": "text-20",
      "creditType": "TEXT",
      "units": 20,
      "priceMinor": 9900,
      "currency": "RUB",
      "version": 1
    }
  ]
}
```

Order after checkout creation:

```json
{
  "data": {
    "id": "11111111-1111-4111-8111-111111111111",
    "packCode": "text-20",
    "creditType": "TEXT",
    "units": 20,
    "priceMinor": 9900,
    "currency": "RUB",
    "packVersion": 1,
    "status": "AWAITING_PAYMENT",
    "paymentStatus": "PENDING",
    "fulfillmentStatus": "PENDING",
    "fulfilledAt": null,
    "providerPaymentId": "22222222-2222-4222-8222-222222222222",
    "confirmationUrl": "https://yookassa.ru/checkout/example",
    "paymentUrl": "https://yookassa.ru/checkout/example",
    "expiresAt": null,
    "paidAt": null,
    "createdAt": "2026-10-20T08:00:00.000Z"
  }
}
```

After server verification: `status=PAID`, `paymentStatus=SUCCEEDED`,
`fulfillmentStatus=FULFILLED`, `paidAt` and `fulfilledAt` contain ISO timestamps.
Redirect handling must only show the order and call the check endpoint; a redirect never grants credits.

Errors use the existing `{ "error": { "code", "message", "details", "requestId" } }` envelope:

| Code                              | HTTP | Meaning/action                                                 |
| --------------------------------- | ---- | -------------------------------------------------------------- |
| CHECKOUT_DISABLED                 | 503  | Test checkout flag is off                                      |
| CHECKOUT_NOT_ALLOWED              | 403  | User is not on the explicit test allowlist                     |
| PAYMENT_WEBHOOK_DISABLED          | 503  | Webhook receiver is disabled                                   |
| PURCHASE_ORDER_NOT_FOUND          | 404  | Missing or foreign order                                       |
| PAYMENT_NOT_CONFIRMED             | 409  | No payment attempt or order cannot start payment               |
| PAYMENT_VERIFICATION_FAILED       | 409  | Provider object differs from the server snapshot; do not grant |
| PAYMENT_RECONCILIATION_REQUIRED   | 409  | Unknown create result older than 23h; manual investigation     |
| PAYMENT_PROVIDER_UNAVAILABLE      | 503  | Timeout/network/provider error; safe retry with same order     |
| PAYMENT_PROVIDER_INVALID_RESPONSE | 502  | Invalid provider response; investigate                         |
| INVALID_PAYMENT_NOTIFICATION      | 400  | Malformed/unsupported notification                             |

## Durable processing and reconciliation

The server persists a random payment-attempt key, start time, return URL and order snapshot before
making a provider POST. A lost response is recovered with the same request/key, including across
configuration changes. YooKassa guarantees idempotency for 24 hours; the server refuses another
create POST after 23 hours without a known provider ID. Do not generate a new key to work around
this refusal. Inspect the merchant dashboard and match the order/attempt metadata first.

Every received notification stores only event name/payment ID and a hash. Raw provider payloads,
card/contact details and secrets are never persisted or logged. Verified state and rejections are
new immutable PaymentEvents. A database trigger rejects UPDATE/DELETE of PaymentEvent.
Duplicates are deduplicated by deterministic keys; older states cannot downgrade PAID orders.
YooKassa notifications do not use a custom shared-secret signature: the security boundary is the
server-authenticated GET plus exact payment ID, account, amount, currency, test flag and metadata
checks. Transient provider failures return non-200 so delivery can retry. Optional reverse-proxy
rate limiting/IP restrictions can supplement verification, using the official current IP list.

The PURCHASE ledger grant and order PAID/FULFILLED state share one serializable transaction.
Retries cannot grant twice. A failed transaction leaves no partial grant. The reconciler handles
pending payments, unknown create responses inside the safe replay window, and PAID/PENDING orders.
It processes up to 100 oldest candidates per run; failed candidates are counted and require follow-up.
There is no automatically enabled recurring job in this slice.

```sh
npm run build
npm run payments:reconcile
# Inside the backend deployment:
docker exec autobot-api node dist/payment-reconcile.js
```

Reconciliation emits aggregate counts and exits nonzero when any candidate fails. It never emits
credentials, raw payloads or personal data.

## Migration, seed and rollback

New migration: `20261020090000_test_payment_lifecycle`. It adds the durable attempt fields,
fulfillment state/timestamp and immutable-event trigger. It retains all old routes, enums and fields.

```sh
npm ci
npm run prisma:generate
npm run prisma:migrate:deploy
npm run generation-packs:provision
npm run openapi:billing:generate
npm run verify
```

The migration image runs migrations plus repeatable catalogue provisioning automatically.
Provisioning twice is included in the verification gate. CI also runs the migration image twice
against a fresh disposable database. The migration roundtrip test removes/reapplies only the new
schema objects in an isolated test database and verifies existing order snapshots survive.

Before deployment take a verified database backup. Operational rollback is **application rollback**:
disable new checkout, retain webhook/check/reconciliation until in-flight payments finish, then
redeploy the previous known-good SHA. Keep the additive columns and PaymentEvents/ledger intact.
Never drop paid orders, rewrite ledger entries, or run a production down migration to undo payment.
Refund compensation and production Stars integration are separate pending slices; do not advertise
refund automation until implemented.

## Configuration and controlled test procedure

Backend runtime configuration (server `.env`, propagated through backend Compose only):

- `YOOKASSA_SHOP_ID`, `YOOKASSA_SECRET_KEY`: backend GitHub secrets delivered by the existing
  protected workflow fragment. Never put them in bot config or diagnostic output.
- `YOOKASSA_RETURN_URL`: backend-controlled HTTPS return URL, saved per attempt.
- `YOOKASSA_TEST_CHECKOUT_ENABLED=false`: explicit opt-in for starting test attempts.
- `YOOKASSA_TEST_USER_IDS=`: comma-separated backend user UUIDs; nonempty allowlist required on enable.
- `YOOKASSA_WEBHOOK_ENABLED=false`: enable only on the controlled test backend; leave enabled while
  draining existing attempts even after disabling new checkout.
- `YOOKASSA_REQUEST_TIMEOUT_MS=10000`; official API base URL is enforced in production.

No workflow automatically turns these flags on. The full manual env renderer explicitly defaults
checkout/webhook to false. The routine secret merge preserves the server's nonsecret runtime settings.

1. Use an isolated staging backend/database and a YooKassa **test shop**. Do not mix test-funded
   wallets with future live production wallets. Keep prepaid generation disabled initially.
2. Release the verified `dev` SHA via the manual Backend CI/CD workflow. Confirm health revision,
   migration success and catalogue. Verify credential **presence only**, never dump `env` or `.env`:

   ```sh
   docker exec autobot-api node -e 'for (const k of ["YOOKASSA_SHOP_ID","YOOKASSA_SECRET_KEY"]) console.log(k + ": " + Boolean(process.env[k]))'
   ```

3. Set the return URL, allowlist and test checkout/webhook flags on that test environment, recreate
   only the backend API. Register its public HTTPS `/api/v1/payments/yookassa/webhook` URL for payment
   succeeded/canceled notifications in the test shop.
4. Create `text-20` order through signed bot REST, then POST its `/payment`. Inspect pending state
   and follow confirmationUrl with the test payment method from YooKassa test documentation.
5. Confirm redirect alone does not grant. Check the order via POST `/payment/check`. Require
   SUCCEEDED + FULFILLED, exactly one PURCHASE entry and exactly 20 added TEXT credits.
6. Repeat webhook/check and creation on the same order; ledger and provider payment ID must remain
   unchanged. Run reconciliation and check aggregate counts. Repeat for an IMAGE pack.
7. Disable new test checkout. Drain existing attempts using webhook/check/reconciliation. Keep the
   test database isolated. Review generation/media slices, refunds, Stars, backup/restore and rollout
   criteria before any production prepaid activation.

No real payment has been performed as part of the automated verification. Provider HTTP is mocked,
while NestJS, PostgreSQL transactions, HMAC authentication and migration images are real.

## Request status after this slice

| Original item                                                                           | Status                                                   |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Catalogue, balances, ledger, orders, payment create/check contract                      | done for test checkout                                   |
| Server catalogue/snapshots and gift                                                     | implemented; provisioning/concurrent gift covered        |
| YooKassa capture/redirect/durable idempotency                                           | done for test checkout                                   |
| Verified webhook, duplicate/out-of-order handling, atomic fulfillment                   | done for test checkout                                   |
| Pending/paid-but-unfulfilled reconciliation                                             | done as explicit bounded CLI; scheduling pending rollout |
| Compensating refunds                                                                    | pending                                                  |
| Full prepaid revision/image/resume flow and acceptance matrix                           | pending separate slice                                   |
| Controlled real provider test, production secret presence verification for this release | pending deployment                                       |
| Production channel/Stars implementation and global prepaid activation                   | pending decision/implementation; disabled                |

## Changed files in this slice

```text
.env.example
compose.yaml
docs/BILLING_TEST_CHECKOUT.md
docs/DEPLOYMENT.md
docs/GENERATION_PACKS_IMPLEMENTATION.md
docs/architecture/environment-variables.md
docs/openapi/billing.openapi.json
docs/openapi/openapi.yaml
package.json
prisma/migrations/20261020090000_test_payment_lifecycle/migration.sql
prisma/schema.prisma
scripts/ci/quality.sh
scripts/ci/render-production-env.mjs
scripts/export-billing-openapi.mjs
src/common/database/serializable-transaction.spec.ts
src/common/database/serializable-transaction.ts
src/config/environment.spec.ts
src/config/environment.ts
src/generation-packs/billing.openapi.ts
src/generation-packs/generation-packs.controller.ts
src/generation-packs/generation-packs.dto.ts
src/generation-packs/generation-packs.module.ts
src/generation-packs/payments.controller.ts
src/generation-packs/payments.service.ts
src/generation-packs/purchase.service.ts
src/generation-packs/wallet.service.ts
src/generation-packs/yookassa.adapter.spec.ts
src/generation-packs/yookassa.adapter.ts
src/payment-reconcile.ts
test/payments.integration.spec.ts
test/setup-env.ts
```
