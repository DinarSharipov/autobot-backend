# Backend deployment

## Topology

The backend and grammY bot are independent Compose projects on the same host:

- backend project: `autobot-backend` in `/opt/autobot/backend`;
- bot project: `autobot-bot` in `/opt/autobot/bot`;
- shared external Docker network: `autobot-shared`;
- bot backend URL: `http://autobot-api:3000`;
- backend-only internal network: `autobot-backend-internal`;
- PostgreSQL and Redis have no public ports in production.

Neither deployment may run `docker compose down` outside its own project or restart containers
owned by the other repository. The shared network is infrastructure with an independent lifecycle
and must not be removed by either deployment.

## GitHub Environment

Create the `production` environment in `DinarSharipov/autobot-backend`. Restrict it to the `dev`
branch and add an approval rule if the repository plan supports it.

Environment secrets:

- `SERVER_HOST`
- `SERVER_PORT`
- `SERVER_USER`
- `SERVER_KNOWN_HOSTS`
- `SERVER_SSH_KEY` (preferred) or `SERVER_PASSWORD` (fallback)
- `AUTOBOT_DB_PASSWORD`
- `TELEGRAM_OIDC_CLIENT_SECRET`
- `TELEGRAM_BOT_TOKEN`
- `BOT_SERVICE_ACTIVE_SECRET`

Environment variables:

- `API_PUBLIC_URL`
- `CORS_ALLOWED_ORIGINS`
- `WEB_ALLOWED_RETURN_URLS`
- `TELEGRAM_OIDC_CLIENT_ID`
- `TELEGRAM_OIDC_REDIRECT_URI`
- `BOT_SERVICE_ACTIVE_KEY_ID`

Optional variables with safe defaults:

- `AUTOBOT_DB_USER=autobot`
- `AUTOBOT_DB_NAME=autobot`
- `REDIS_KEY_PREFIX=autobot:production`
- `QUEUE_PREFIX=autobot:production`
- `TELEGRAM_OIDC_ISSUER=https://oauth.telegram.org`
- `TELEGRAM_OIDC_SCOPES=openid profile`
- `SESSION_COOKIE_SAME_SITE=none`

The bot repository must receive the same `BOT_SERVICE_ACTIVE_KEY_ID` and
`BOT_SERVICE_ACTIVE_SECRET`. It must not receive database, Redis, OIDC, or backend deployment
credentials.

## Pipeline

Pull requests to `dev` run formatting, linting, Prisma/OpenAPI validation, type checking, unit
tests, integration tests, and the application build.

A push to `dev` additionally publishes two immutable GHCR images tagged with the commit SHA:

- the API runtime image;
- the Prisma migration image.

Deployment uploads only Compose definitions and a generated mode-0600 environment file, pulls the
immutable images, starts PostgreSQL and Redis, runs `prisma migrate deploy`, updates only
`autobot-api`, and waits for its Docker health check. The deployment never restarts `autobot-bot`.

## First deployment prerequisites

- Public HTTPS routing for `API_PUBLIC_URL` must already terminate TLS and forward to the API.
- Telegram OIDC URLs must be registered with BotFather.
- The publishing bot must have the required permissions in target channels.
- The GHCR package must inherit access from this repository so the workflow token can pull it.
- Keep a verified PostgreSQL backup before applying non-trivial production migrations.
