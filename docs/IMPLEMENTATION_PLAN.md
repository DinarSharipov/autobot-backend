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
