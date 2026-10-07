# IMPLEMENTATION_STATUS.md

## Current status
Repository initialized. Architecture documentation added on branch `docs/architecture-backend`.

## Approved architecture
- [x] Separate backend repository
- [x] NestJS
- [x] Prisma
- [x] PostgreSQL
- [x] Redis
- [x] BullMQ
- [x] Docker
- [x] Shared bot/API network: `autobot-shared`
- [x] Private backend network: `backend-internal`
- [x] API Docker DNS alias: `autobot-api`
- [x] Bot has no direct DB/Redis access
- [x] Backend independent from grammY
- [x] Workers initially may run in API container
- [x] Future worker container supported by architecture

## Product decisions captured
- [x] Immediate one-time posts
- [x] Scheduled one-time posts
- [x] Scheduled recurring posts
- [x] AUTO publishing
- [x] MODERATION publishing
- [x] Revision requests before approval
- [x] Subscription-based channel/topic/moderation/image limits
- [x] Telegram Mini App not required for MVP

## Implementation progress
- [ ] NestJS scaffold
- [ ] Configuration
- [ ] Prisma schema
- [ ] PostgreSQL runtime
- [ ] Redis runtime
- [ ] BullMQ queues
- [ ] Users module
- [ ] Channels module
- [ ] Topics module
- [ ] Posts/versioning module
- [ ] Moderation module
- [ ] Scheduling module
- [ ] Publishing module
- [ ] AI adapters
- [ ] Subscription/usage module
- [ ] Telegram publisher
- [ ] Docker Compose
- [ ] Health checks
- [ ] CI/CD
- [ ] Automated tests
