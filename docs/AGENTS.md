# AGENTS.md

## Project
Autobot is a Telegram-first service for creating, scheduling, moderating, and publishing AI-generated posts to Telegram channels.

This repository contains the core backend and infrastructure. The Telegram client lives in `DinarSharipov/autobot`.

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
This repository is the business core of Autobot. It owns domain state, validation, subscription rules, AI orchestration, scheduling, queues, and Telegram publication.

The backend MUST NOT depend on grammY.

Expected architecture:
```
grammY bot -> HTTP -> NestJS API
                       |-> PostgreSQL
                       |-> Redis/BullMQ
                       |-> AI providers
                       -> Telegram Bot API for publication
```

## Docker topology
All services are deployed on the same server.

Containers:
- `autobot-api`
- `autobot-postgres`
- `autobot-redis`

The bot is deployed separately from the `autobot` repository.

Networks:
- `autobot-shared`: external shared network between `autobot-bot` and `autobot-api`
- `backend-internal`: internal network for API, PostgreSQL, and Redis

Only the API should be reachable by the bot. PostgreSQL and Redis must stay on `backend-internal`.

Internal bot-to-backend URL:
```
http://autobot-api:3000
```

## Core responsibilities
Modules should include:
- users
- telegram accounts
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

Subscription/entitlement rules must be centralized, for example through `EntitlementService` and `UsageService`. Do not scatter plan checks across controllers.

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

## Engineering rules
- Controllers should be thin.
- Put business logic in application/domain services.
- Prisma is infrastructure, not the domain model.
- Keep Telegram publication behind an adapter/service.
- Keep AI providers behind adapters.
- Make jobs idempotent where possible.
- Persist durable state in PostgreSQL.
- Use Redis for queues/ephemeral coordination, not as the source of truth.
- Keep the API independent from grammY so future Mini App/web clients can reuse it.
