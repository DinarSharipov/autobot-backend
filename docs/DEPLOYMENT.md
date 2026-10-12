# Backend deployment

## Topology

The backend and grammY bot are independent Compose projects on the same host:

- backend project: `autobot-backend` in `/opt/autobot/backend`;
- bot project: `autobot-bot` in `/opt/autobot/bot`;
- shared external Docker network: `autobot-shared`;
- bot backend URL: `http://autobot-api:3000`;
- public Swagger UI: `${API_PUBLIC_URL}/api/docs`;
- public OpenAPI JSON: `${API_PUBLIC_URL}/api/docs-json`;
- backend-only internal network: `autobot-backend-internal`;
- PostgreSQL and Redis have no public ports in production.

The current host needs `seccomp=unconfined` only for `autobot-postgres` because its legacy Docker
seccomp profile rejects a PostgreSQL initialization syscall. The database remains isolated on the
private backend network; remove this compatibility exception after the host runtime is upgraded.

Neither deployment may run `docker compose down` outside its own project or restart containers
owned by the other repository. The shared network is infrastructure with an independent lifecycle
and must not be removed by either deployment.

## GitHub Environment

The default deployment does not store SSH or runtime secrets in GitHub. GitHub publishes the
`:dev` images; `autobot-backend-update.timer` on the server detects a new image revision, applies
migrations, updates only the backend containers, and keeps the bot project untouched. The GitHub
production job waits until health reports the pushed commit SHA and then verifies OpenAPI.

Create the `production` environment in `DinarSharipov/autobot-backend`, restrict it to `dev`, and
optionally set `API_PUBLIC_URL`. The workflow uses the current production URL by default.

The following values are needed only for the retained manual SSH deployment fallback:

Environment secrets:

- `SERVER_HOST`
- `SERVER_PORT`
- `SERVER_USER`
- `SERVER_KNOWN_HOSTS`
- `SERVER_SSH_KEY` (preferred) or `SERVER_PASSWORD` (fallback)
- `AUTOBOT_DB_PASSWORD`
- `TELEGRAM_BOT_TOKEN`
- `BOT_SERVICE_ACTIVE_SECRET`

Environment variables:

- `API_PUBLIC_URL`
- `BOT_SERVICE_ACTIVE_KEY_ID`

Optional observability configuration:

- Set `METRICS_ENABLED=true` only when a private monitoring path is available.
- Provide a separate `METRICS_AUTH_TOKEN` (at least 32 characters) and send it as the
  `X-Metrics-Token` header to `/api/v1/internal/metrics`.
- Do not publish the metrics route through a public monitoring URL or place the token in logs.

Deferred until the final Web Admin stage:

- secret `TELEGRAM_OIDC_CLIENT_SECRET`;
- variables `CORS_ALLOWED_ORIGINS`, `WEB_ALLOWED_RETURN_URLS`,
  `TELEGRAM_OIDC_CLIENT_ID`, and `TELEGRAM_OIDC_REDIRECT_URI`.

Leave all OIDC values empty for the current bot-only deployment. Browser authentication endpoints
then fail closed with `503 TELEGRAM_OIDC_NOT_CONFIGURED`; bot HMAC authentication and the domain API
remain available.

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

The server-side updater pulls the published tags, reads their immutable revision labels, validates
that the API and migration revisions match, writes the corresponding immutable image references,
runs `prisma migrate deploy`, updates only `autobot-api`, and waits for its Docker health check. The
deployment never restarts `autobot-bot`. GitHub marks deployment successful only after production
health reports the same revision and the live OpenAPI document is available.

## First deployment prerequisites

- Public HTTPS routing for `API_PUBLIC_URL` is provided by the `autobot-proxy` Caddy service.
- Telegram OIDC URLs are registered with BotFather only during the final Web Admin stage.
- The publishing bot must have the required permissions in target channels.
- The GHCR package must inherit access from this repository so the workflow token can pull it.
- Keep a verified PostgreSQL backup before applying non-trivial production migrations.
