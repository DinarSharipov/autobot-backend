# IMPLEMENTATION_STATUS.md

## Current status

Stages 1–4 are complete: contracts, backend foundation, identity/access, and core
domain/entitlements are runtime-verified.
Live Telegram login still requires deployment credentials and registered BotFather URLs.
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
- [x] Shared user/domain model
- [x] Secure cookie-based browser session
- [x] Telegram Mini App / Web App excluded
- [x] Shared bot/API network: `autobot-shared`
- [x] Private backend network: `backend-internal`
- [x] Web Admin does not join backend Docker networks
- [x] Public HTTPS API required for Web Admin

## CI/CD

- [x] `SERVER_HOST` configured in GitHub Actions
- [x] `SERVER_PORT` configured in GitHub Actions
- [x] `SERVER_USER` configured in GitHub Actions
- [x] Dedicated `SERVER_SSH_KEY` configured
- [x] `SERVER_KNOWN_HOSTS` configured
- [ ] GitHub Actions workflow implementation
- [ ] First deployment validation

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
- [x] Telegram authentication
- [x] Session management
- [x] CORS/public HTTPS API configuration
- [x] Prisma schema
- [x] PostgreSQL runtime
- [x] Redis runtime
- [x] BullMQ queues
- [x] Users/AuthIdentity module
- [x] Channels module
- [x] Topics module
- [ ] Posts/versioning module
- [ ] Moderation module
- [ ] Scheduling module
- [ ] Publishing module
- [ ] AI adapters
- [x] Subscription/usage module
- [ ] Telegram publisher
- [x] Docker Compose
- [x] Health checks
- [ ] CI/CD workflow
- [x] Automated tests
