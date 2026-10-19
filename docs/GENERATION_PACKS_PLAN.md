# Generation packs and prepaid balances

## Decision and status — 2026-10-19

Approved product direction. This document replaces subscription tiers, monthly generation quotas,
subscription-gated moderation/images, and previous restrictions excluding image review.
Implementation and migration are IN PROGRESS; existing subscription code is legacy, not evidence that
prepaid balances already work in production. Historical test results describe the code tested at that time.
Web Admin implementation, deployment, and activation remain postponed.

Concrete backend changes, migration sequencing and API work are recorded in
[GENERATION_PACKS_IMPLEMENTATION.md](GENERATION_PACKS_IMPLEMENTATION.md).

## Product and commercial rules

- Users buy TEXT and IMAGE generation packs independently. No recurring subscription, renewal,
  monthly reset, or monthly expiry of purchased credits. Balances are user-wide across channels.
- One successful initial text generation consumes one TEXT credit and grants exactly three
  included successful AI revisions/regenerations for that generated post occurrence.
- Both feedback-driven revisions and "regenerate" use that same included allowance.
- Every successful fourth or later revision consumes one TEXT credit after explicit cost confirmation.
  A paid revision does NOT grant another set of three included revisions.
- Copying, editing, reapproving, or rescheduling the same content does not reset the allowance.
  Each newly generated recurring occurrence has its own initial charge and three included revisions.
  A content-definition change starts a new paid generation only through an explicit generation command.
- Every successful image generation, including a replacement/regeneration, consumes one IMAGE credit.
  Text balance cannot fund images and image balance cannot fund text.
- Text revisions do not silently generate/charge for images. Mark an existing image as potentially
  outdated and let the user keep it or explicitly buy a replacement.
- Approval, rejection, manual editing, scheduling and delivery of existing content have no AI-credit fee.
- Terminal provider failures, invalid/empty/truncated/oversized results and internal technical retries
  do not consume user credits or included revisions. Provider costs are recorded separately.
- Completed accepted generation remains consumed if the user later rejects/deletes the artifact.
  A Telegram delivery failure does not refund a successfully generated artifact or charge it again.
- Do not auto-fallback from included revisions to paid revisions in races; return an updated cost
  requiring confirmation. Backend concurrency checks are authoritative.
- Channel/topic limits are global operational policy, not paid tiers. Initial proposed defaults:
  3 active channels and 10 active topics per account; expose limits through the API.
- One-time onboarding gift: 3 TEXT and 1 IMAGE credit, as recorded in [PRICING.md](PRICING.md). Provision idempotently per user;
  do not reset it monthly or on re-login. Keep gifts separate from purchased grants in the ledger.

## Pricing source of truth

The agreed starting pack prices, unit prices, one-time trial (3 TEXT + 1 IMAGE),
cost assumptions and review conditions are in [PRICING.md](PRICING.md).
Do not maintain a duplicate price table here or hardcode prices in clients.
Catalogue values are server-controlled; each order snapshots quantity, type, currency,
price and catalogue version. Documentation does not enable live checkout.

## Backend accounting and payments

- Model GenerationWallet, immutable CreditLedgerEntry, GenerationReservation, TextRevisionAllowance,
  GenerationPack, PurchaseOrder and PaymentEvent (final names may follow repository conventions).
- Track available/reserved TEXT and IMAGE separately with integer units. In one database transaction
  reserve a credit or included revision before dispatch, then commit once on accepted success or release
  once on terminal failure/cancellation before successful generation.
- Persist an allowance against the owning user and immutable generation group/publication occurrence;
  do not attach it solely to the reusable Post definition or each new PostVersion.
- Unique operation keys cover payment grants, reservations, commits, releases, gifts and refunds.
  Duplicate callbacks, webhooks, queue retries and worker recovery must not duplicate charges/grants.
- A balance cannot become negative due to concurrent reservations; do not hold database transactions
  while calling GPTunnel. Reconcile abandoned reservations against durable job/provider state.
- Schedules materialize occurrences without charging at configuration time. Reserve at generation time.
  Insufficient funds block the occurrence and notify the owner; do not loop provider calls, silently
  publish text instead of a selected image, or spend the wrong wallet. Top-up/resume reuses the occurrence.
- YooKassa integration stays backend-owned: server-created orders, idempotent payment requests,
  authenticated/verified provider status, exact amount/currency/order matching and unique provider IDs.
  Credit only confirmed successful payment, never a client redirect or unverified webhook.
- Handle delayed, duplicate, invalid and out-of-order notifications; reconcile pending payments.
  Refund through compensating ledger entries linked to the original order, with an explicit policy
  for spent/reserved credits and failed refunds. Never delete ledger history.
- Provide authenticated API contracts for catalogue, balances/reservations, purchase status/history,
  ledger, generation cost preview, remaining included revisions and insufficient-balance errors.
  Names/routes are proposals until OpenAPI and controllers implement them.
- Replace client dependence on GET /subscription and monthly GET /usage gradually; coordinate versioned
  or additive contracts and remove legacy endpoints only after clients migrate.
- Migrate with an audited snapshot of current users, subscriptions, counters and in-flight jobs.
  Do not silently turn historical usage or old quotas into paid credits. Record an explicit conversion
  policy before migration, retain old history, reconcile reservations, feature-flag cutover and document
  rollback. Do not run old and new charging paths for one operation.

## Image workflow and fixed generation profile

- Current tested profile: gpt-image-2.5-flare with
  {"variant":"medium","resolution":"1K","aspect_ratio":"1:1"}.
  Current measured provider price: 3 RUB/image; prices may change.
- Current runtime text model: gpt-5.6-luna; measured sample text costs 0.075–0.335 RUB,
  one sample revision 0.213 RUB. Samples are estimates, not guaranteed cost ceilings.
- Keep model/quality/size server-owned. User chooses whether an image is needed, not provider settings.
- MODERATION requires image preview, explicit replacement price (1 IMAGE) and approval of the selected
  image version before sending to the channel. A new preview does not trigger channel publication.
- AUTO continues unattended and creates one selected image; replacement is an explicit user action.
- Reuse the approved generated image for final delivery and retries; never regenerate it automatically
  at publish time or double-charge after restart. Stale preview callbacks cannot replace approved content.
- Preserve the prohibition on durable image bytes, base64, provider URLs and local paths in PostgreSQL
  and on adding S3/MinIO in MVP. Plan a revision to the media ADR: temporary download followed by a private
  Telegram preview and durable Telegram file_id/version metadata, ownership checks and cleanup.
  Telegram file_id is a delivery reference, not the image bytes or a provider URL.
- Define lost/expired/unavailable media handling and user notification; do not silently purchase another
  image to recover it. Future Web preview access must be authenticated and is deferred with Web Admin.
- Keep AI conversations/prompts/raw responses ephemeral. Retain final text, cost/token metadata,
  payment/accounting state, and minimum media-reference state required for selected-image reuse.
- Keep the existing 4096 token output ceiling until measured changes are validated; enforce Telegram
  character limits independently. Failed corrective attempts do not charge user credits.

## Acceptance criteria (pending)

1. Initial text costs 1 TEXT; exactly three successful revisions are included; later revisions cost
   1 TEXT without resetting allowance. New recurring occurrences have independent allowances.
2. Two concurrent requests for the last included revision cannot both use it or silently charge money.
3. Every image replacement costs 1 IMAGE; no TEXT debit; preview/approval/delivery reuse the same image.
4. No duplicate debit/grant under concurrent API calls, repeated payment events or worker restarts.
5. Failures release reservations; rejected successful content remains charged; delivery retries are free.
6. Purchased credits survive month boundaries and catalogue changes; gifts are granted only once.
7. Insufficient funds block only the relevant operation with a clear top-up/resume flow.
8. Verified payment credits exactly the purchased pack; redirect alone and forged callbacks grant nothing.
9. Bot and future Web read the same balances, allowances, operation prices and purchase states.
10. Legacy migration and rollback are rehearsed with in-flight work; historical results are not
    relabelled as successful tests of the new model.

## Backend delivery plan

- [ ] Finalize billing, allowance and selected-image OpenAPI/domain contracts before client implementation.
- [x] Add wallet/ledger/reservation/order/payment/allowance schema and migrations with concurrency constraints.
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

## Detailed purchase delivery tasks

Repository-specific checkout tasks, shared proposed APIs, dependencies and launch preparation are
tracked in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md#purchase-integration-coordination--2026-10-19).
All purchase implementation and activation items remain pending.
