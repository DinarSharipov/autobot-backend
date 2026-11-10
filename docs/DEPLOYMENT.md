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

Production deployments target the replacement server through GitHub Environment values,
not a hard-coded server address. Configure the `production` environment in
`DinarSharipov/autobot-backend` and restrict it to `dev`.

**Required environment secrets**:

- `SERVER_HOST` — new server IP or SSH hostname.
- `SERVER_PORT`, `SERVER_USER`, `SERVER_KNOWN_HOSTS` — SSH access and the independently verified new SSH host key.
- `SERVER_SSH_KEY` (preferred) or `SERVER_PASSWORD`.
- `AUTOBOT_DB_PASSWORD`, `TELEGRAM_BOT_TOKEN`, `BOT_SERVICE_ACTIVE_SECRET`.
- `YOOKASSA_SHOP_ID`, `YOOKASSA_SECRET_KEY`.

**Required environment variable**:

- `API_PUBLIC_URL` — public HTTPS backend URL resolving to the *new* host.
  Example: `https://autobot.NEW_IP.sslip.io`, substituting the actual address.
  This is also used to configure Caddy's `API_HOST` and to verify the live revision.
- `BOT_SERVICE_ACTIVE_KEY_ID` — HMAC key identifier; it must match the bot.

Optional GitHub secret `GPTUNNEL_API_KEY` is needed for AI generation. Additional
production variables supported by the initial environment renderer include
`AUTOBOT_DB_USER`, `AUTOBOT_DB_NAME`, `AI_TEXT_MODEL`, `AI_IMAGE_MODEL`,
`GPTUNNEL_IMAGE_PARAMS`, `GPTUNNEL_USE_WALLET_BALANCE`,
`AI_TEXT_MAX_TOKENS`, `AI_REQUEST_TIMEOUT_MS`, `AI_IMAGE_TIMEOUT_MS`,
`AI_IMAGE_POLL_INTERVAL_MS`, `PREPAID_GENERATION_ENABLED`,
`YOOKASSA_RETURN_URL`, `YOOKASSA_TEST_CHECKOUT_ENABLED`,
`YOOKASSA_WEBHOOK_ENABLED`, `YOOKASSA_TEST_USER_IDS`,
`CORS_ALLOWED_ORIGINS` and `WEB_ALLOWED_RETURN_URLS`.
Keep values not ready for use disabled/empty.

### First deployment to an empty replacement server

1. Provision a Linux server with Docker Engine and the Docker Compose plugin.
   Expose SSH to GitHub runners, and HTTP/HTTPS for Caddy.
2. Register and verify the new server in Gateway; verify its SSH host-key
   fingerprint using a trustworthy channel before updating `SERVER_KNOWN_HOSTS`.
3. Create/update the environment secrets and variables above; ensure GHCR
   images can be pulled from this server.
4. Manually start **Actions → Backend CI/CD → Run workflow** on `dev`.
5. The job renders a protected full `.env` for an empty host and a small
   YooKassa fragment for upgrades. If `/opt/autobot/backend/.env` does not exist,
   the full file is installed; otherwise the prior server-side values are
   preserved and only the YooKassa fragment and image SHA are updated.
   Secret-containing staging files are mode `0600` and never committed.
6. Wait for PostgreSQL, Redis and API health; Caddy starts after API readiness,
   then the workflow verifies the commit SHA and OpenAPI at `API_PUBLIC_URL`.
7. Only after the backend is healthy, deploy the separate bot repository.

**Important:** This bootstraps new *empty* PostgreSQL and Redis volumes; it
does **not** migrate data from the old server. To retain users, payments,
schedules and channel settings, restore a verified PostgreSQL backup before
starting the bot. Keep old server data untouched until backup/restore is verified.

A push/PR to `dev` only runs backend CI validation; it does not deploy.
`SERVER_HOST` and `SERVER_KNOWN_HOSTS` must be updated in GitHub Environment
secrets; changing Gateway's saved host does not change GitHub Actions.

The test checkout contract and controlled rollout procedure are in
[BILLING_TEST_CHECKOUT.md](BILLING_TEST_CHECKOUT.md). Verified refunds, debt accounting and rollback
restrictions are documented in [BILLING_REFUNDS.md](BILLING_REFUNDS.md).
Set `YOOKASSA_RETURN_URL` as a non-secret server runtime variable for test checkout. A redirect to
this URL never confirms payment; fulfillment requires a verified provider status or webhook.

Environment variables:

- `API_PUBLIC_URL`
- `BOT_SERVICE_ACTIVE_KEY_ID`

GPTunnel generation configuration:

- Set `GPTUNNEL_API_KEY` on the backend server. Replace the retired `OPEN_API_KEY` setting;
  OpenAI credentials are not accepted by the new adapters.
- Set `AI_TEXT_MODEL` and `AI_IMAGE_MODEL` to IDs available to this key in the GPTunnel catalogues.
- Optionally configure `GPTUNNEL_IMAGE_PARAMS` as a JSON object from the image model schema,
  `AI_TEXT_MAX_TOKENS`, `AI_REQUEST_TIMEOUT_MS`, `AI_IMAGE_TIMEOUT_MS`, and
  `AI_IMAGE_POLL_INTERVAL_MS`.
- `GPTUNNEL_USE_WALLET_BALANCE` applies only to text. Media generation needs a funded account
  with Creative Lab access.
- Compose and the manual production-env renderer both pass these settings to the API. The bot
  and Web Admin must never receive the provider key.
- Missing credentials leave health endpoints usable; AI requests fail safely with
  `AI_PROVIDER_NOT_CONFIGURED`.

Optional observability configuration:

- Set `METRICS_ENABLED=true` only when a private monitoring path is available.
- Provide a separate `METRICS_AUTH_TOKEN` (at least 32 characters) and send it as the
  `X-Metrics-Token` header to `/api/v1/internal/metrics`.
- Do not publish the metrics route through a public monitoring URL or place the token in logs.

Web Admin development and deployment are currently postponed. The following configuration remains
deferred until a future Web Admin stage:

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

Before pushing, install the local hook once with `npm run hooks:install`, then use
`npm run verify`. The pre-push hook also runs this command. It creates disposable PostgreSQL 17
and Redis 8 containers on random localhost ports, runs the shared quality/integration gates,
applies all migrations, provisions the catalogue twice, and builds both deployment images.
It removes the test containers even on failure. Docker must be running.

CI runs the same `ci:quality` and `ci:integration` scripts and validates both Docker targets
on every push/PR, including a clean-checkout migration build. Background jobs are disabled in
domain/auth/health tests; the dedicated pipeline tests exercise real queue consumers.
Do not consider a push verified until all jobs for its exact commit have completed successfully.

Pushes and pull requests to `dev` run validation and integration checks. They do not change
production. A production release is started manually with **Actions → Backend CI/CD → Run workflow**
using the `dev` branch. That run publishes two immutable GHCR images tagged with the selected commit
SHA:

- the API runtime image;
- the Prisma migration image.

The SSH deploy script pulls those immutable SHA references, runs `prisma migrate deploy`, updates only
`autobot-api`, and waits for its Docker health check. The deployment never restarts `autobot-bot`.
GitHub marks deployment successful only after production health reports the same revision and the live
OpenAPI document is available.

## First deployment prerequisites

- Public HTTPS routing for `API_PUBLIC_URL` is provided by the `autobot-proxy` Caddy service.
- Telegram OIDC URLs are registered with BotFather only during the final Web Admin stage.
- The publishing bot must have the required permissions in target channels.
- The GHCR package must inherit access from this repository so the workflow token can pull it.
- Keep a verified PostgreSQL backup before applying non-trivial production migrations.
