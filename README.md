# Autobot Backend

Central NestJS API and infrastructure services for Autobot.

## Requirements

- Node.js 24.15 or newer within the Node 24 line
- npm 11.6 or newer
- Docker Desktop with Docker Compose

## Local start

Create the shared network once:

```powershell
docker network create autobot-shared
```

Copy `.env.example` to `.env` and adjust local values. Never commit `.env`. Then run:

```powershell
npm.cmd ci
npm.cmd run prisma:generate
docker compose -f compose.yaml -f compose.dev.yaml up -d autobot-postgres autobot-redis
npm.cmd run prisma:migrate:deploy
npm.cmd run start:dev
```

The development Compose override publishes only loopback ports:

- API: `http://127.0.0.1:3000`
- PostgreSQL: `127.0.0.1:5432`
- Redis: `127.0.0.1:6380`

The OpenAPI document is available at `http://127.0.0.1:3000/api/docs-json`. Liveness and
readiness are exposed at `/api/v1/health/live` and `/api/v1/health/ready`.

To run the complete development stack in Docker:

```powershell
npm.cmd run docker:up
```

The base `compose.yaml` does not publish PostgreSQL or Redis ports. It stores PostgreSQL data
in the local `autobot-postgres-data` Docker volume and keeps temporary generated images in a
size-limited, non-persistent `tmpfs` owned by the unprivileged API user.

## Authentication setup

Telegram browser login uses Authorization Code Flow with PKCE. Register the exact callback URL
in BotFather and configure `TELEGRAM_OIDC_CLIENT_ID`, `TELEGRAM_OIDC_CLIENT_SECRET`,
`TELEGRAM_OIDC_REDIRECT_URI`, and at least one `WEB_ALLOWED_RETURN_URLS` entry. Without the
credentials, development health endpoints remain available while login returns a safe `503`.

Browser sessions use an opaque Secure/HttpOnly cookie. PostgreSQL stores only its SHA-256 hash.
Browser mutations require the session-bound token from `GET /api/v1/auth/csrf` in the
`X-CSRF-Token` header.

Bot requests use the HMAC headers documented in
[`docs/architecture/adr/0003-bot-service-authentication.md`](docs/architecture/adr/0003-bot-service-authentication.md).
Configure a dedicated `BOT_SERVICE_ACTIVE_KEY_ID` and `BOT_SERVICE_ACTIVE_SECRET`; never reuse
the Telegram bot token. A previous key pair may remain configured temporarily during rotation.

Channel linking and revalidation use the Telegram Bot API. Configure `TELEGRAM_BOT_TOKEN` for the
same bot that will publish posts. The API verifies that the target is a channel and that the bot is
an administrator allowed to post; development without the token returns a safe `503` for these
operations.

## Database workflow

Create a migration after changing `prisma/schema.prisma`:

```powershell
npm.cmd run prisma:migrate:dev -- --name <migration-name>
```

Apply committed migrations:

```powershell
npm.cmd run prisma:migrate:deploy
```

The application provisions the version-controlled `free` and `pro` plans idempotently at startup.
The default `free` plan applies when a user has no currently effective `ACTIVE` or `TRIALING`
subscription.

Integration tests use the separate `autobot_test` database. The cleanup helper refuses to
operate unless the database name ends with `_test`.

## Verification

```powershell
npm.cmd run format:check
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run test:integration
npm.cmd run build
npm.cmd audit
```

PostgreSQL stores user settings, final post artifacts, and required domain/operational state.
GPT conversation payloads and generated images must never be persisted. Images may exist only
as temporary local files during publication and must be deleted after use or expiry.
