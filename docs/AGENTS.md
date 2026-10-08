# AGENTS.md

## Project

Autobot is a Telegram-first service for creating, scheduling, moderating, and publishing AI-generated posts to Telegram channels.

This repository contains the core backend and backend infrastructure only.

Related repositories:

- `DinarSharipov/autobot` — grammY Telegram bot.
- `DinarSharipov/autobot-web` — standalone React Web Admin.

## Communication

- All communication with the project owner must be in Russian unless the owner explicitly asks for another language.

## Technology stack

- Node.js
- TypeScript
- NestJS
- Prisma ORM
- PostgreSQL
- Redis
- BullMQ
- Docker

## Architectural role

This repository is the business core of Autobot. It owns domain state, validation, authentication, subscription rules, AI orchestration, scheduling, queues, and Telegram publication.

The NestJS API is the central application boundary and MUST NOT depend on grammY or React UI code.

Expected architecture:

```
Telegram -> grammY bot -> internal HTTP ----\
                                             -> NestJS API -> Application/Domain
Browser -> React Web Admin -> public HTTPS -/                 |-> PostgreSQL
                                                               |-> Redis/BullMQ
                                                               |-> AI providers
                                                               -> Telegram Bot API
```

The bot and backend are deployed on the same server. The Web Admin is deployed to a different server and reaches the backend only through the public HTTPS API.

## Web Admin integration

Web Admin lives in `DinarSharipov/autobot-web` and is not implemented or deployed from this repository.

Backend requirements for Web Admin:

- REST API available over HTTPS
- Telegram-based authentication endpoints
- same application user/domain model as the bot
- credentialed CORS restricted to configured Web Admin origin(s)
- secure browser sessions
- state changes made through one client immediately visible to the other through persisted backend state

Telegram Mini App / Telegram Web App is excluded from the product plan.

## Authentication

Web Admin authentication uses Telegram identity.

Architecture requirements:

- authentication module in backend
- external identity model such as `AuthIdentity` with provider `TELEGRAM`
- bot identity and Web Admin identity resolve to the same `User`
- secure server-side/browser session after login
- HttpOnly + Secure cookies with SameSite policy appropriate to final production domains
- no bearer token persistence in browser localStorage
- email/password auth is out of scope for MVP
- alternative identity providers are out of scope for MVP

## Docker topology

Current backend server containers:

- `autobot-api`
- `autobot-postgres`
- `autobot-redis`

Telegram bot is deployed from `DinarSharipov/autobot` to the same server as `autobot-bot`.

Networks:

- `autobot-shared`: external network between `autobot-bot` and `autobot-api`
- `backend-internal`: internal network for API, PostgreSQL, and Redis

Internal bot-to-backend URL:

```
http://autobot-api:3000
```

Web Admin does NOT join these Docker networks because it will run on another server.

PostgreSQL and Redis must never be publicly exposed. Only the required backend HTTPS entry point is public for Web Admin.

## Core responsibilities

Backend modules should include:

- auth
- users
- auth identities / Telegram identities
- channels
- topics
- posts
- post versions
- moderation
- generation
- publishing
- scheduling
- subscriptions
- usage/limits
- AI integrations
- Telegram publishing integration

## Core product rules

Supported post modes:

- immediate one-time post
- scheduled one-time post
- scheduled recurring post

Publishing modes:

- AUTO: generated content proceeds to publication automatically
- MODERATION: generated content waits for user review; revisions may be requested before approval

Subscription/entitlement rules must be centralized, for example through `EntitlementService` and `UsageService`.

At minimum subscription policy controls:

- number of channels
- number of topics
- moderation/revision usage
- image generation availability/usage

## Data retention

- PostgreSQL on the backend server's local persistent disk is the only durable application data store in MVP.
- Persist user settings and domain state required for product behavior.
- Persist final generated post text needed for moderation, publication, and history.
- Do not persist GPT/provider conversation messages, assembled system prompts, raw provider responses, or hidden reasoning.
- Do not store generated image bytes, base64, URLs, or filesystem paths in PostgreSQL.
- Do not introduce S3, MinIO, or another durable image/object store in MVP.
- Generate an optional image only after text is ready/approved and immediately before Telegram publication.
- Image files may exist only in a restricted temporary local directory and must be deleted after upload, terminal failure/cancellation, or TTL expiry.
- Image preview/moderation before publication is out of scope for MVP.

## Scheduling and queues

Use Redis + BullMQ for:

- post generation jobs
- scheduled publication
- recurring publication
- retries
- other background work

Image generation is executed inside the publication job immediately before Telegram upload so image content is not passed durably between jobs.

Do not implement durable scheduling with in-memory timers.

Initially BullMQ workers may run inside the API process. The architecture must allow moving them later into a separate `autobot-worker` container without changing domain contracts.

## Data model direction

Keep these concepts separate:

- Post
- PostVersion
- PostSchedule
- Publication

Likely entities:

- User
- AuthIdentity
- TelegramAccount
- Channel
- Topic
- Post
- PostVersion
- PostSchedule
- Publication
- ModerationRequest
- Subscription
- SubscriptionPlan
- Usage
- AIRequest
- Session

## Engineering rules

- Controllers should be thin.
- Put business logic in application/domain services.
- Prisma is infrastructure, not the domain model.
- Keep Telegram publication behind an adapter/service.
- Keep AI providers behind adapters.
- Never persist or log GPT conversation payloads or image content.
- Make jobs idempotent where possible.
- Persist durable state in PostgreSQL.
- Use Redis for queues/ephemeral coordination, not as the source of truth.
- Keep the API independent from grammY and React.
- Bot and Web Admin must not duplicate business rules.
- Never assume the Web Admin is reachable through local Docker DNS.
