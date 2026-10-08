# IMPLEMENTATION_PLAN.md

## Goal

Build the central NestJS backend for Autobot with durable persistence, queue-based generation and publication, Telegram authentication, and one REST API shared by the grammY bot and the separately deployed Web Admin.

This repository remains backend-only. The grammY client is developed in `DinarSharipov/autobot`; the React Web Admin is developed and deployed from `DinarSharipov/autobot-web`.

## Delivery strategy

Implementation is split into dependency-ordered stages. Each stage has its own detailed plan under [`implementation-plans`](./implementation-plans/README.md).

| Stage | Plan                                                                                                          | Outcome                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1     | [Contracts and domain design](./implementation-plans/01-contracts-and-domain/IMPLEMENTATION_PLAN.md)          | Approved API, identity, state, scheduling, and data contracts                              |
| 2     | [Backend foundation](./implementation-plans/02-backend-foundation/IMPLEMENTATION_PLAN.md)                     | Runnable NestJS service with PostgreSQL, Redis, BullMQ, Docker, and baseline observability |
| 3     | [Identity and access](./implementation-plans/03-identity-and-access/IMPLEMENTATION_PLAN.md)                   | Unified Telegram identity, browser sessions, bot service authentication, and protected API |
| 4     | [Core domain and entitlements](./implementation-plans/04-core-domain-and-entitlements/IMPLEMENTATION_PLAN.md) | Channels, topics, subscriptions, and centralized usage enforcement                         |
| 5     | [Publication pipeline](./implementation-plans/05-publication-pipeline/IMPLEMENTATION_PLAN.md)                 | Generation, versioning, moderation, scheduling, and idempotent Telegram publication        |
| 6     | [Production readiness](./implementation-plans/06-production-readiness/IMPLEMENTATION_PLAN.md)                 | Tested CI/CD, secure deployment, monitoring, backup, and operational runbooks              |

## Sequencing rules

- Do not freeze the Prisma schema or public DTOs before Stage 1 decisions are approved.
- Keep the API independent from grammY and Web Admin implementation details.
- Treat PostgreSQL as the source of truth; Redis and BullMQ are execution and coordination infrastructure.
- Persist only user/domain data; keep GPT conversations and generated images out of PostgreSQL.
- Use local ephemeral image files only inside publication processing and delete them deterministically.
- Keep public browser traffic on HTTPS and internal bot traffic on Docker DNS.
- Deliver and test each domain capability through the REST boundary before starting the next dependent capability.
- Keep queue processors separable from the API so they can move to an `autobot-worker` container later.

## Global definition of done

A stage is complete only when:

- its documented deliverables exist and unresolved decisions are recorded;
- lint, type checking, tests, and production build pass;
- database changes have migrations and rollback/compatibility notes;
- API changes are represented in OpenAPI and verified by contract tests;
- authorization, ownership, idempotency, and failure paths are covered where applicable;
- operational configuration is documented without committing secrets;
- `IMPLEMENTATION_STATUS.md` is updated with verified progress.
