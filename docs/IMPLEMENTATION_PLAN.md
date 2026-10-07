# IMPLEMENTATION_PLAN.md

## Goal
Build the NestJS business backend for Autobot with durable persistence, queue-based scheduling, and an API consumed by the grammY bot.

## Planned implementation

### 1. Bootstrap
- Initialize NestJS + TypeScript.
- Add configuration/environment validation.
- Add Prisma.
- Add PostgreSQL.
- Add Redis.
- Add BullMQ.
- Add structured logging, health checks, and error handling.

### 2. Domain modules
Implement modules for:
- users / Telegram identities
- channels
- topics
- posts
- post versions
- moderation
- generation
- publishing
- schedules
- subscriptions
- usage/limits

Keep controllers thin and expose use cases through application services.

### 3. Prisma schema
Start with entities around:
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

Keep Post, PostVersion, Publication, and Schedule separate.

### 4. Post lifecycle
Support:
- immediate one-time publication
- scheduled one-time publication
- scheduled recurring publication

Support publication policy:
- AUTO
- MODERATION

Moderated lifecycle should support:
1. generate draft
2. persist version
3. wait for user action
4. create revised version when requested
5. approve
6. publish
7. persist publication result

### 5. AI integration
- Text generation behind provider adapter.
- Image generation behind provider adapter.
- Persist requests/usage needed for accounting.
- Enforce entitlements before costly operations.

### 6. Subscription and limits
Centralize policy in services such as:
- `EntitlementService`
- `UsageService`

Enforce at least:
- channel count
- topic count
- moderation/revision quota
- image-generation access/quota

### 7. Redis/BullMQ
Create queues/jobs for:
- GeneratePost
- GenerateImage
- PublishPost
- ScheduledPublish
- RecurringPublish
- RetryPublication

Jobs should be restart-safe and idempotent where possible.

Initially workers may run inside `autobot-api`. Keep queue processors separable so a future `autobot-worker` container can be introduced without redesign.

### 8. Telegram publishing
- Backend publishes scheduled/automatic posts directly through Telegram Bot API.
- Do not route background publishing through the grammY application.
- Encapsulate Telegram API calls behind a publisher adapter.

### 9. Docker networking
Create:
- external network `autobot-shared`
- internal network `backend-internal`

Attach:
- API -> both networks
- PostgreSQL -> `backend-internal`
- Redis -> `backend-internal`

API network alias:
```
autobot-api
```

The API does not need a public port for bot communication. If a public client is added later, expose it through a reverse proxy/TLS entry point.

### 10. CI/CD
- Lint/test/build on push/PR.
- Run Prisma validation/migration checks.
- Build Docker image.
- Deploy/restart API infrastructure safely on the shared server.
- Preserve PostgreSQL and Redis volumes.
- Do not restart the bot during backend-only deployment unless required by an incompatible API change.
