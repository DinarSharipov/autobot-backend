# IMPLEMENTATION_PLAN.md

## Goal
Build the central NestJS backend for Autobot with durable persistence, queue-based scheduling, Telegram authentication, and one REST API shared by the grammY bot and the separately deployed Web Admin.

## Planned implementation

### 1. Backend bootstrap
- Initialize NestJS + TypeScript.
- Add configuration/environment validation.
- Add Prisma.
- Add PostgreSQL.
- Add Redis.
- Add BullMQ.
- Add structured logging, health checks, and error handling.
- Expose REST API for grammY and Web Admin clients.

### 2. Authentication
Implement Telegram-based Web Admin authentication.

Requirements:
- validate Telegram login identity on the backend
- introduce `AuthIdentity` with provider `TELEGRAM`
- map bot and browser identity to the same `User`
- create secure browser session
- use HttpOnly + Secure cookies
- configure SameSite policy from final production domain topology
- no bearer-token persistence in browser localStorage
- no email/password auth in MVP
- no alternative identity providers in MVP

### 3. Public Web API boundary
Because `autobot-web` will run on another server:
- expose required API routes through HTTPS
- configure explicit Web Admin origin allowlist
- support credentialed CORS only for trusted origins
- do not expose PostgreSQL or Redis
- do not rely on `autobot-shared` for browser/Web Admin traffic
- keep internal bot traffic on Docker DNS

### 4. Domain modules
Implement:
- auth
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

### 5. Prisma schema
Start with:
- User
- AuthIdentity
- TelegramAccount
- Session
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

### 6. Post lifecycle
Support:
- immediate one-time publication
- scheduled one-time publication
- scheduled recurring publication
- AUTO publishing
- MODERATION publishing
- multiple revised post versions

The same persisted state must be available from both grammY and Web Admin.

### 7. AI integration
- Text generation behind provider adapter.
- Image generation behind provider adapter.
- Persist accounting/usage.
- Enforce entitlements before costly operations.

### 8. Subscription and limits
Centralize policy in:
- `EntitlementService`
- `UsageService`

Enforce at least:
- channel count
- topic count
- moderation/revision quota
- image-generation access/quota

### 9. Redis/BullMQ
Queues/jobs:
- GeneratePost
- GenerateImage
- PublishPost
- ScheduledPublish
- RecurringPublish
- RetryPublication

Jobs should be restart-safe and idempotent where possible.

Initially workers may run inside `autobot-api`; keep processors separable for future `autobot-worker`.

### 10. Telegram publishing
- Backend publishes scheduled/automatic posts directly through Telegram Bot API.
- Do not route background publishing through grammY.
- Encapsulate Telegram API behind a publisher adapter.

### 11. Docker networking
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

Web Admin runs on another server and is not part of this Compose project.

### 12. CI/CD
GitHub Actions deployment secrets for the current backend server:
- `SERVER_HOST`
- `SERVER_PORT`
- `SERVER_USER`
- `SERVER_SSH_KEY`
- `SERVER_KNOWN_HOSTS`

Pipeline goals:
- lint/test/build on push/PR
- Prisma validation/migration checks
- build backend Docker image
- deploy/restart backend services safely
- preserve PostgreSQL/Redis volumes
- do not deploy `autobot-web` from this repository
