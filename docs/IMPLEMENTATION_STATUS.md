# IMPLEMENTATION_STATUS.md

## Current status

Stages 1–4 are complete: contracts, backend foundation, bot service access, and core
domain/entitlements are runtime-verified.
Stage 5 is in progress: post definitions and immediate publication occurrences use an atomic
text-usage reservation and durable outbox event. The OpenAI text adapter and generation worker
persist immutable versions plus content-free accounting metadata. Moderation approval, rejection,
and revision requests now use optimistic versions, idempotent commands, immutable replacement
versions, and durable generation dispatch. One-time and recurring scheduling now persist UTC
occurrences, validate a supported RRULE subset, preserve local wall-clock time across DST, and
reconcile missed occurrences transactionally; live provider execution still requires an API
account with available quota. Text-only Telegram delivery now has a durable publisher,
retry/backoff, ambiguous-delivery protection, and publication history/retry/cancel endpoints;
ephemeral image generation remains the next publication slice.
Telegram OIDC activation and browser sessions are intentionally deferred until the core Telegram
bot workflow is complete. Bot-only production runs without OIDC credentials; browser login
endpoints remain implemented but return `503 TELEGRAM_OIDC_NOT_CONFIGURED` until the final Web
Admin stage.
Live channel validation requires the publishing bot token and administrator access to a real
Telegram channel.

## Approved architecture

- [x] Backend-only repository
- [x] Web Admin moved to `DinarSharipov/autobot-web`
- [x] Web Admin will deploy to a different future server
- [x] NestJS API is the central application boundary
- [x] Prisma + PostgreSQL
- [x] Redis + BullMQ
- [x] Docker
- [x] REST API shared by bot and Web Admin
- [x] Telegram-based Web Admin authentication belongs to backend
- [x] Telegram OIDC activation deferred until after the core bot workflow
- [x] Shared user/domain model
- [x] Secure cookie-based browser session
- [x] Telegram Mini App / Web App excluded
- [x] Shared bot/API network: `autobot-shared`
- [x] Private backend network: `backend-internal`
- [x] Web Admin does not join backend Docker networks
- [x] Public HTTPS API required for Web Admin

## CI/CD

- [x] Server-side pull deployment avoids GitHub runtime secrets
- [x] GitHub Actions workflow implementation
- [x] First deployment validation

## Planning and contracts

- [x] Dependency-ordered implementation stages documented
- [x] Stage 1 contracts and domain design completed
- [x] Telegram OIDC and browser session architecture accepted
- [x] Bot HMAC service authentication accepted
- [x] Domain ER model and Prisma schema proposal created
- [x] Lifecycle, scheduling, queue, retry, and ephemeral-image semantics documented
- [x] Local PostgreSQL persistence boundary documented
- [x] GPT conversations and generated images excluded from database persistence
- [x] Initial shared OpenAPI contract created and linted
- [x] Client integration and environment-variable contracts documented

## Product decisions captured

- [x] Immediate one-time posts
- [x] Scheduled one-time posts
- [x] Scheduled recurring posts
- [x] AUTO publishing
- [x] MODERATION publishing
- [x] Revision requests before approval
- [x] Subscription-based channel/topic/moderation/image limits
- [x] Shared moderation state between bot and Web Admin

## Implementation progress

- [x] Contracts/domain design
- [x] NestJS scaffold
- [x] Configuration
- [x] Telegram authentication implementation (production activation deferred)
- [x] Session management
- [x] CORS/public HTTPS API configuration
- [x] Prisma schema
- [x] PostgreSQL runtime
- [x] Redis runtime
- [x] BullMQ queues
- [x] Users/AuthIdentity module
- [x] Channels module
- [x] Topics module
- [x] Posts/versioning module (post definitions, immediate occurrence and version-history read API)
- [x] Moderation module (approval, rejection, revision, shared queue state)
- [x] Scheduling module (one-time/recurring RRULE schedules, pause/resume/cancel, durable materialization and reconciliation)
- [x] Publishing module (text-only delivery, durable retry state, publication history)
- [ ] AI adapters
- [x] Subscription/usage module
- [x] Telegram publisher (text-only; image delivery remains)
- [x] Docker Compose
- [x] Health checks
- [x] CI/CD workflow
- [x] Automated tests
