# IMPLEMENTATION_PLAN.md

## Goal
Build the central NestJS backend and standalone React Web Admin for Autobot, with durable persistence, queue-based scheduling, Telegram authentication, and a REST API shared by the grammY bot and Web Admin.

## Planned implementation

### 1. Repository structure
Use this repository for all non-bot services.

Recommended high-level structure:
```
apps/
  api/
  web/
```

Shared packages may be introduced for contracts/types where useful, but domain logic must remain server-side.

### 2. Backend bootstrap
- Initialize NestJS + TypeScript.
- Add configuration/environment validation.
- Add Prisma.
- Add PostgreSQL.
- Add Redis.
- Add BullMQ.
- Add structured logging, health checks, and error handling.
- Expose REST API for both grammY and Web Admin clients.

### 3. Web Admin bootstrap
- Initialize React + TypeScript browser application.
- Configure API client/session handling.
- Implement authenticated application shell/navigation.
- Keep UI state separate from domain rules.

### 4. Authentication
Implement Telegram-based Web Admin authentication.

Requirements:
- validate Telegram login identity on the backend
- introduce `AuthIdentity` with provider `TELEGRAM`
- map bot and browser identity to the same `User`
- create secure browser session
- use HttpOnly + Secure + appropriate SameSite cookies
- do not persist auth bearer tokens in localStorage
- no email/password auth in MVP
- no alternative identity providers in MVP

### 5. Domain modules
Implement modules for:
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

Keep controllers thin and expose use cases through application services.

### 6. Prisma schema
Start with entities around:
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

### 7. Post lifecycle
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

The same moderation state must be available from both grammY and Web Admin.

### 8. Web Admin product areas
Implement:
- Dashboard
- Publications/posts
- Calendar
- Topics
- Schedules
- Channels
- Moderation
- Publication history
- Subscription/usage

The Web Admin is a normal browser application and must not depend on Telegram Mini App APIs.

### 9. AI integration
- Text generation behind provider adapter.
- Image generation behind provider adapter.
- Persist requests/usage needed for accounting.
- Enforce entitlements before costly operations.

### 10. Subscription and limits
Centralize policy in services such as:
- `EntitlementService`
- `UsageService`

Enforce at least:
- channel count
- topic count
- moderation/revision quota
- image-generation access/quota

The same rules apply to actions initiated from bot and Web Admin.

### 11. Redis/BullMQ
Create queues/jobs for:
- GeneratePost
- GenerateImage
- PublishPost
- ScheduledPublish
- RecurringPublish
- RetryPublication

Jobs should be restart-safe and idempotent where possible.

Initially workers may run inside `autobot-api`. Keep queue processors separable so a future `autobot-worker` container can be introduced without redesign.

### 12. Telegram publishing
- Backend publishes scheduled/automatic posts directly through Telegram Bot API.
- Do not route background publishing through the grammY application.
- Encapsulate Telegram API calls behind a publisher adapter.

### 13. Docker networking
Create:
- external network `autobot-shared`
- internal network `backend-internal`

Attach:
- API -> both networks
- PostgreSQL -> `backend-internal`
- Redis -> `backend-internal`
- Web Admin -> public routing and API connectivity as required by deployment

API network alias:
```
autobot-api
```

Bot-to-API traffic stays private through Docker DNS. Browser traffic for Web Admin/API must use HTTPS/public routing. PostgreSQL and Redis must never be publicly exposed.

### 14. CI/CD
- Lint/test/build API and Web Admin on push/PR.
- Run Prisma validation/migration checks.
- Build required Docker images.
- Deploy/restart backend services safely on the shared server.
- Preserve PostgreSQL and Redis volumes.
- Do not restart the bot during backend/Web Admin deployment unless required by an incompatible API change.
