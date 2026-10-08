# IMPLEMENTATION_STATUS.md

## Current status
Repository initialized. Architecture updated to move Web Admin into its own repository and future server.

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
- [ ] NestJS scaffold
- [ ] Configuration
- [ ] Telegram authentication
- [ ] Session management
- [ ] CORS/public HTTPS API configuration
- [ ] Prisma schema
- [ ] PostgreSQL runtime
- [ ] Redis runtime
- [ ] BullMQ queues
- [ ] Users/AuthIdentity module
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
- [ ] CI/CD workflow
- [ ] Automated tests
