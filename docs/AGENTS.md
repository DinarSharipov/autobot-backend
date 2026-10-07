# AGENTS.md

## Project
Autobot is a Telegram-first service for creating, scheduling, moderating, and publishing AI-generated posts to Telegram channels.

This repository contains all non-bot services: the core backend, infrastructure, and the standalone Web Admin. The Telegram client lives in `DinarSharipov/autobot`.

## Communication
- All communication with the project owner must be in Russian unless the owner explicitly asks for another language.

## Technology stack
Backend:
- Node.js
- TypeScript
- NestJS
- Prisma ORM
- PostgreSQL
- Redis
- BullMQ

Web Admin:
- React
- TypeScript

Infrastructure:
- Docker

## Architectural role
This repository is the business and service core of Autobot. It owns domain state, validation, authentication, subscription rules, AI orchestration, scheduling, queues, Telegram publication, and the standalone browser administration client.

The NestJS API is the central application boundary and MUST NOT depend on grammY or on Web Admin UI code.

Expected architecture:
```
Telegram -> grammY bot ----                            -> REST API -> Application/Domain layer
Browser -> React Web Admin-/               |-> PostgreSQL
                                            |-> Redis/BullMQ
                                            |-> AI providers
                                            -> Telegram Bot API
```

Both grammY and Web Admin are independent clients of the same backend and must operate on the same user/domain data.

## Web Admin
A standalone Web Admin is REQUIRED in MVP.

Requirements:
- regular browser application, not Telegram Mini App / Telegram Web App
- React + TypeScript
- Telegram-based authentication
- same Autobot account as the Telegram bot
- REST API is required in MVP and must support both clients

Main Web Admin areas:
- Dashboard
- Publications/posts
- Calendar
- Topics
- Schedules
- Channels
- Moderation
- Publication history
- Subscription/usage

Telegram Mini App / Telegram Web App is excluded from the current product plan.

## Authentication
Web Admin authentication must use Telegram identity.

Architecture requirements:
- introduce an authentication module in the backend
- model external identities explicitly, for example `AuthIdentity` with provider `TELEGRAM`
- Telegram bot identity and Web Admin identity must resolve to the same application user
- after Telegram login, establish a secure server-side/browser session
- use HttpOnly + Secure + appropriate SameSite cookies
- do not store authentication bearer tokens in localStorage
- email/password authentication is out of scope for MVP
- alternative identity providers are out of scope for MVP

## Docker topology
All services are deployed on the same server.

Target containers:
- `autobot-api`
- `autobot-web`
- `autobot-postgres`
- `autobot-redis`

The bot is deployed separately from the `autobot` repository as `autobot-bot`.

Networks:
- `autobot-shared`: external shared network between `autobot-bot` and `autobot-api`
- `backend-internal`: internal network for API, PostgreSQL, and Redis

Only the API should be reachable by the bot. PostgreSQL and Redis must stay on `backend-internal`.

Internal bot-to-backend URL:
```
http://autobot-api:3000
```

The browser-facing Web Admin and API must be exposed through HTTPS/public routing without exposing PostgreSQL or Redis.

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

Subscription/entitlement rules must be centralized, for example through `EntitlementService` and `UsageService`. Do not scatter plan checks across controllers or UI clients.

At minimum subscription policy controls:
- number of channels
- number of topics
- moderation/revision usage
- image generation availability/usage

## Scheduling and queues
Use Redis + BullMQ for:
- post generation jobs
- image generation jobs
- scheduled publication
- recurring publication
- retries
- other background work

Do not implement durable scheduling with in-memory timers.

Initially BullMQ workers may run inside the API process. The architecture must allow moving them later into a separate `autobot-worker` container without changing domain contracts.

## Data model direction
Keep these concepts separate:
- Post
- PostVersion
- PostSchedule
- Publication

A post may have multiple generated/revised versions during moderation.

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
- Make jobs idempotent where possible.
- Persist durable state in PostgreSQL.
- Use Redis for queues/ephemeral coordination, not as the source of truth.
- Keep the API independent from grammY and React.
- Bot and Web Admin must not duplicate business rules.
- State changes from one client must be visible from the other through the common backend.
