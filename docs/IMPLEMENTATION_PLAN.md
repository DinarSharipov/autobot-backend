# IMPLEMENTATION_PLAN.md

> Product decision (2026-10-19): [Generation packs and prepaid balances](GENERATION_PACKS_PLAN.md) supersedes subscription tiers/monthly quotas and the old exclusion of image preview. The transition is planned, not implemented. Legacy behavior and historical verification below must not be treated as the new billing contract.

## Goal

Build the central NestJS backend for Autobot with durable persistence, queue-based generation and publication, Telegram authentication, and one REST API shared by the grammY bot and the separately deployed Web Admin.

This repository remains backend-only. The grammY client is developed in `DinarSharipov/autobot`; the React Web Admin is developed and deployed from `DinarSharipov/autobot-web`.

> **Current product scope:** Web Admin development, deployment, and activation are postponed.
> The Telegram bot is the only active client. Preserve the API and authentication boundaries needed
> for a future browser client, but do not begin the final Web Admin activation stage until the
> product decision is revised.

## Delivery strategy

Implementation is split into dependency-ordered stages. Each stage has its own detailed plan under [`implementation-plans`](./implementation-plans/README.md).

| Stage | Plan                                                                                                          | Outcome                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1     | [Contracts and domain design](./implementation-plans/01-contracts-and-domain/IMPLEMENTATION_PLAN.md)          | Approved API, identity, state, scheduling, and data contracts                              |
| 2     | [Backend foundation](./implementation-plans/02-backend-foundation/IMPLEMENTATION_PLAN.md)                     | Runnable NestJS service with PostgreSQL, Redis, BullMQ, Docker, and baseline observability |
| 3     | [Identity and access](./implementation-plans/03-identity-and-access/IMPLEMENTATION_PLAN.md)                   | Unified Telegram identity, browser sessions, bot service authentication, and protected API |
| 4     | [Core domain and entitlements](./implementation-plans/04-core-domain-and-entitlements/IMPLEMENTATION_PLAN.md) | Channels, topics, prepaid wallets, packs, and centralized credit accounting                         |
| 5     | [Publication pipeline](./implementation-plans/05-publication-pipeline/IMPLEMENTATION_PLAN.md)                 | Generation, versioning, moderation, scheduling, and idempotent Telegram publication        |
| 6     | [Production readiness](./implementation-plans/06-production-readiness/IMPLEMENTATION_PLAN.md)                 | Tested CI/CD, secure deployment, monitoring, backup, and operational runbooks              |
| 7     | Final Web Admin activation (postponed)                                                                        | Register Telegram OIDC URLs, configure browser login, CORS, cookies, and live verification |

## Sequencing rules

- Do not freeze the Prisma schema or public DTOs before Stage 1 decisions are approved.
- Keep the API independent from grammY and Web Admin implementation details.
- Treat PostgreSQL as the source of truth; Redis and BullMQ are execution and coordination infrastructure.
- Persist only user/domain data; keep GPT conversations and generated images out of PostgreSQL.
- Use temporary image files for generation/preview/delivery and delete them deterministically; persist only the approved minimal Telegram media reference for later reuse.
- Keep public browser traffic on HTTPS and internal bot traffic on Docker DNS.
- Deliver and test each domain capability through the REST boundary before starting the next dependent capability.
- Keep queue processors separable from the API so they can move to an `autobot-worker` container later.
- Keep Telegram OIDC credentials optional in bot-only production. Activate and live-test browser
  login only after the core Telegram bot functionality is complete.

## Global definition of done

A stage is complete only when:

- its documented deliverables exist and unresolved decisions are recorded;
- lint, type checking, tests, and production build pass;
- database changes have migrations and rollback/compatibility notes;
- API changes are represented in OpenAPI and verified by contract tests;
- authorization, ownership, idempotency, and failure paths are covered where applicable;
- operational configuration is documented without committing secrets;
- `IMPLEMENTATION_STATUS.md` is updated with verified progress.

## Priority: generation packs migration (2026-10-19)

## Backend delivery plan

- [ ] Finalize billing, allowance and selected-image OpenAPI/domain contracts before client implementation.
- [ ] Add wallet/ledger/reservation/order/payment/allowance schema and migrations with concurrency constraints.
- [ ] Replace subscription-gated policies and monthly quotas with prepaid credits and global resource caps.
- [ ] Implement one initial TEXT debit plus three included revisions and paid revisions thereafter.
- [ ] Make recurring occurrence, failure, cancellation, retry and insufficient-funds accounting atomic.
- [ ] Implement purchase catalogue, YooKassa checkout, payment reconciliation and compensating refund ledger.
- [ ] Add selected-image preview/regeneration/approval/reuse and update media ADR/retention contracts.
- [ ] Document and rehearse legacy cutover and rollback; do not invent a conversion of old quotas.
- [ ] Update runtime provisioning, README/configuration, OpenAPI, bot integration and operational runbooks.
- [ ] Add meaningful backend unit/integration/contract tests for all acceptance cases; run lint, typecheck,
  build and existing required checks. Add billing cases to the acceptance catalogue without rewriting history.
- [ ] Deploy only after compatible client contracts and migration verification are complete.

Use [GENERATION_PACKS_PLAN.md](GENERATION_PACKS_PLAN.md) as the billing contract; supersede conflicting legacy tasks above.

## Purchase integration coordination — 2026-10-19

Status: planned only; this documentation does not activate checkout or deploy billing.
Backend owns prices, orders, payment verification and credit accounting. Clients only display
backend state. Canonical prices and the one-time gift (3 TEXT + 1 IMAGE) are maintained in
[backend PRICING.md](https://github.com/DinarSharipov/autobot-backend/blob/dev/docs/PRICING.md);
do not copy price tables or gift constants into clients.

Delivery order: backend contracts and wallets -> backend test checkout and reconciliation ->
bot purchase UI -> integrated acceptance and legacy cutover -> production payment activation.
Web Admin work remains deferred and is not a prerequisite for bot/backend checkout.
Use hosted YooKassa redirect checkout as the technical MVP scenario; no recurring payments.
Telegram requires Stars for digital services sold inside Telegram; an external redirect does not
remove that requirement. Record the production sales-channel decision before enabling the bot
purchase entry point. Keep payment adapters separate from wallet accounting.
Reference: https://core.telegram.org/bots/payments-stars

Proposed shared contracts (finalize in backend OpenAPI before implementation):
- GET /api/v1/billing/packs: server catalogue, version, credit type, quantity, RUB amount.
- GET /api/v1/billing/balance: available/reserved TEXT and IMAGE.
- POST /api/v1/billing/orders: pack ID, catalogue version and stable idempotency key;
  derive owner from authenticated identity and calculate price server-side.
- GET /api/v1/billing/orders and GET /api/v1/billing/orders/{id}: owned purchase history/status,
  payment status, fulfillment status, confirmation URL when applicable.
- GET /api/v1/billing/ledger: owned credit-operation history.
- POST /api/v1/billing/webhooks/yookassa: provider notification endpoint, independently verified;
  not protected by bot HMAC or browser session middleware.
Routes are proposals, not implemented endpoints. Payment status and credit fulfillment status
must be distinguishable; clients never infer a grant from a redirect or provider status alone.

### Backend implementation checklist

- [ ] Finalize DTOs, errors, ownership checks, order/payment/fulfillment state machines and OpenAPI.
- [ ] Add BillingModule and a provider adapter for YooKassa create/get/refund operations using
  server-side shopId/secret. Keep external HTTP calls outside database transactions.
- [ ] Add migrations for packs, TEXT/IMAGE wallets, immutable credit ledger, reservations, orders,
  payment attempts/events and refunds; amounts are integer kopecks, credits are integer units.
  Enforce unique provider payment IDs and unique grant/refund operation keys.
- [ ] Snapshot catalogue version, credit type, quantity, amount and currency in each order.
  Changing catalogue prices must not modify existing orders or purchased credits.
- [ ] Persist an order/payment-attempt idempotency key before provider calls; reuse it on network
  timeout/retry. Recover a provider-created payment after a local persistence failure without
  creating an uncontrolled second charge. Define multiple-attempt and late-success handling.
- [ ] Create hosted redirect payments with capture=true and a configured return URL;
  return confirmation_url to clients. Never save card details or grant from the return URL.
- [ ] Durably accept notifications, validate payloads, fetch authoritative payment through
  authenticated YooKassa API, and match provider account, payment/order association, exact amount,
  RUB currency and test/live mode. Credit only verified succeeded payments.
- [ ] Atomically mark fulfillment and grant the purchased quantity once; handle duplicate,
  concurrent, delayed and out-of-order events without regression or double grants.
  Persist notification/outbox state before HTTP 200; recover failed processing asynchronously.
- [ ] Reconcile pending/unknown payments and paid-but-unfulfilled orders with bounded retries,
  backoff and operational alerts. A local timeout must not be treated as provider cancellation.
- [ ] Notify the owner through a durable outbox/delivery path; failed Telegram notifications must
  not undo payment or credit fulfillment. Bot restarts must not lose pending orders.
- [ ] Replace monthly quota charging with reserve/commit/release wallet accounting; implement
  three included successful text revisions per occurrence, separate image charges and one-time
  3 TEXT + 1 IMAGE gift. Resume blocked occurrences without duplicate generation/debits.
- [ ] Define full/partial refund rules for unused, spent and reserved credits; compensate through
  immutable linked ledger operations. Reconcile provider refund success/failure and concurrent
  generation/refund requests; never delete accounting history.
- [ ] Prepare backend-only YOOKASSA_SHOP_ID, YOOKASSA_SECRET_KEY, YOOKASSA_RETURN_URL,
  BILLING_ENABLED and explicit expected test/live mode (names proposed); document in env example,
  environment validation, Compose and deployment scripts. Never commit actual credentials.
- [ ] Configure public HTTPS webhook ingress (443/8443), TLS, proxy routing and provider events
  payment.succeeded, payment.canceled, refund.succeeded. Keep internal APIs authenticated.
- [ ] Prepare a minimal return/result endpoint with a back-to-bot link; this does not require
  Web Admin or browser OIDC. URL parameters are not payment proof and must not expose order data.
- [ ] Prepare runbook: activated merchant account, enabled payment methods, actual commissions,
  receipt/Мой налог setup for self-employed merchant, service description, support contacts,
  offer/privacy/refund terms, separate test/live credentials and notification configuration.
- [ ] Add meaningful unit/integration/contract cases for success, cancel, timeout, duplicate and
  forged notifications, wrong owner/amount/currency/mode, concurrent fulfillment, restart,
  missed notification, refunds and payment-success/notification-failure recovery.
- [ ] Rehearse migration/rollback with in-flight reservations; no silent old-quota conversion or
  simultaneous old/new debits. Run required backend checks and test-store end-to-end acceptance.
- [ ] Activate production only after receipt setup, channel decision, compatible bot release,
  migrations and test evidence are recorded; document a controlled live payment/refund check.

Provider references:
https://yookassa.ru/developers/payment-acceptance/getting-started/payment-process
https://yookassa.ru/developers/using-api/webhooks
https://yookassa.ru/developers/using-api/interaction-format
