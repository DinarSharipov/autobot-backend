# Environment-variable contract

All variables are validated at process startup. Required production secrets have no fallback. Secret values must not appear in logs, health responses, committed examples, or CI output.

## Runtime and HTTP

| Variable                  | Required     | Secret | Purpose                                                |
| ------------------------- | ------------ | ------ | ------------------------------------------------------ |
| `NODE_ENV`                | yes          | no     | `development`, `test`, or `production`                 |
| `PORT`                    | yes          | no     | API listen port; production default contract is `3000` |
| `API_PUBLIC_URL`          | production   | no     | Canonical public HTTPS API origin                      |
| `BUILD_SHA`               | CI/deploy    | no     | Immutable deployed revision                            |
| `LOG_LEVEL`               | yes          | no     | Structured log level                                   |
| `METRICS_ENABLED`         | yes          | no     | Enables the internal Prometheus endpoint               |
| `METRICS_AUTH_TOKEN`      | conditional  | yes    | Secret `X-Metrics-Token` when metrics are enabled      |
| `TRUST_PROXY_HOPS`        | production   | no     | Explicit reverse-proxy hop count                       |
| `CORS_ALLOWED_ORIGINS`    | browser API  | no     | Comma-separated exact HTTPS Web Admin origins          |
| `WEB_ALLOWED_RETURN_URLS` | browser auth | no     | Exact/prefix allowlist for post-login redirects        |
| `REQUEST_BODY_LIMIT`      | no           | no     | Maximum JSON request size                              |

## PostgreSQL and Redis

| Variable           | Required | Secret                | Purpose                                                          |
| ------------------ | -------- | --------------------- | ---------------------------------------------------------------- |
| `DATABASE_URL`     | yes      | yes                   | Prisma PostgreSQL connection URL                                 |
| `REDIS_URL`        | yes      | yes when credentialed | BullMQ, nonce replay protection, and short-lived OIDC flow state |
| `DB_POOL_MAX`      | no       | no                    | Database pool limit                                              |
| `REDIS_KEY_PREFIX` | yes      | no                    | Environment/service key namespace                                |

## Telegram OIDC and sessions

| Variable                       | Required              | Secret | Purpose                                       |
| ------------------------------ | --------------------- | ------ | --------------------------------------------- |
| `TELEGRAM_OIDC_ISSUER`         | yes                   | no     | Expected issuer; `https://oauth.telegram.org` |
| `TELEGRAM_OIDC_CLIENT_ID`      | final Web Admin stage | no     | Client ID provided by BotFather               |
| `TELEGRAM_OIDC_CLIENT_SECRET`  | final Web Admin stage | yes    | OIDC code-exchange secret                     |
| `TELEGRAM_OIDC_REDIRECT_URI`   | final Web Admin stage | no     | Registered backend callback URL               |
| `TELEGRAM_OIDC_SCOPES`         | yes                   | no     | MVP value `openid profile`                    |
| `OIDC_FLOW_TTL_SECONDS`        | no                    | no     | State/PKCE record TTL; default 600            |
| `OIDC_REQUEST_TIMEOUT_MS`      | no                    | no     | Telegram token/JWKS request timeout           |
| `SESSION_COOKIE_NAME`          | no                    | no     | Default `__Host-autobot_session`              |
| `SESSION_ABSOLUTE_TTL_SECONDS` | no                    | no     | Default 2592000 (30 days)                     |
| `SESSION_IDLE_TTL_SECONDS`     | no                    | no     | Default 604800 (7 days)                       |
| `SESSION_COOKIE_SAME_SITE`     | production            | no     | `lax` or `none` from deployed topology        |
| `SESSION_COOKIE_SECURE`        | production            | no     | Must be `true` in production                  |

`SESSION_COOKIE_DOMAIN` is intentionally absent. The approved `__Host-` cookie is host-only and must not have a Domain attribute.

## Bot service authentication

| Variable                         | Required        | Secret | Purpose                                      |
| -------------------------------- | --------------- | ------ | -------------------------------------------- |
| `BOT_SERVICE_ACTIVE_KEY_ID`      | yes             | no     | Active HMAC key identifier                   |
| `BOT_SERVICE_ACTIVE_SECRET`      | yes             | yes    | Active HMAC secret, at least 32 random bytes |
| `BOT_SERVICE_PREVIOUS_KEY_ID`    | during rotation | no     | Previous accepted key identifier             |
| `BOT_SERVICE_PREVIOUS_SECRET`    | during rotation | yes    | Previous HMAC secret                         |
| `BOT_SERVICE_CLOCK_SKEW_SECONDS` | no              | no     | Default 60                                   |
| `BOT_SERVICE_NONCE_TTL_SECONDS`  | no              | no     | Default 300                                  |

The bot repository receives the matching key ID/secret through its own secret store. `TELEGRAM_BOT_TOKEN` must never be reused as the service HMAC secret.

## Authentication rate limits

| Variable                         | Required | Secret | Purpose                              |
| -------------------------------- | -------- | ------ | ------------------------------------ |
| `AUTH_RATE_LIMIT_MAX`            | no       | no     | Maximum attempts in one fixed window |
| `AUTH_RATE_LIMIT_WINDOW_SECONDS` | no       | no     | Authentication fixed-window duration |

## Telegram publisher

| Variable                  | Required | Secret | Purpose                                                                        |
| ------------------------- | -------- | ------ | ------------------------------------------------------------------------------ |
| `TELEGRAM_BOT_TOKEN`      | yes      | yes    | Backend Telegram Bot API publishing/validation token                           |
| `TELEGRAM_API_BASE_URL`   | no       | no     | Default `https://api.telegram.org`; override only for controlled testing/proxy |
| `TELEGRAM_API_TIMEOUT_MS` | no       | no     | Upstream request timeout; default 10000 ms                                     |

## AI providers

| Variable                      | Required      | Secret | Purpose                                                                    |
| ----------------------------- | ------------- | ------ | -------------------------------------------------------------------------- |
| `GPTUNNEL_API_KEY`            | AI generation | yes    | GPTunnel credential; sent as the raw Authorization value                   |
| `GPTUNNEL_USE_WALLET_BALANCE` | no            | no     | Personal-wallet billing for text; defaults to false; not sent to media API |
| `PREPAID_GENERATION_ENABLED`  | no            | no     | Enables the prepaid write path after bot migration; defaults to false      |
| `AI_TEXT_MODEL`               | no            | no     | Chat model ID from `/v1/models`; default `gpt-4o-mini`                     |
| `AI_IMAGE_MODEL`              | no            | no     | IMAGE model ID from `/api/v2/media/models`; default `gpt-image`            |
| `GPTUNNEL_IMAGE_PARAMS`       | no            | no     | JSON object of model-specific primitive parameters; default `{}`           |
| `AI_TEXT_MAX_TOKENS`          | no            | no     | Text response token budget; default 4096                                   |
| `AI_REQUEST_TIMEOUT_MS`       | no            | no     | Timeout for each provider HTTP request and image download; default 30000   |
| `AI_IMAGE_TIMEOUT_MS`         | no            | no     | Overall image catalogue/create/poll/download deadline; default 180000      |
| `AI_IMAGE_POLL_INTERVAL_MS`   | no            | no     | Asynchronous poll interval; default 2000                                   |
| `YOOKASSA_SHOP_ID`            | production    | yes    | YooKassa shop identifier; retained only in the backend runtime             |
| `YOOKASSA_SECRET_KEY`         | production    | yes    | YooKassa API key; retained only in the backend runtime                     |
| `YOOKASSA_API_BASE_URL`       | payment test  | no     | YooKassa v3 endpoint; defaults to the official API URL                     |
| `YOOKASSA_RETURN_URL`         | payment test  | no     | Backend-controlled redirect return URL; redirect never confirms payment    |

`OPEN_API_KEY` is retired. Configure a GPTunnel key explicitly; no credential fallback or direct
OpenAI requests remain. Model availability and supported parameters are account-specific; verify
the authenticated catalogue. See [GPTunnel integration](./gptunnel.md).

## Local ephemeral image processing

| Variable                     | Required         | Secret | Purpose                                                      |
| ---------------------------- | ---------------- | ------ | ------------------------------------------------------------ |
| `IMAGE_TEMP_DIR`             | image generation | no     | Restricted local temporary directory; never exposed publicly |
| `IMAGE_TEMP_TTL_SECONDS`     | no               | no     | Maximum temporary-file lifetime before cleanup               |
| `IMAGE_MAX_BYTES`            | no               | no     | Generated image size cap before Telegram upload              |
| `IMAGE_TEMP_MAX_TOTAL_BYTES` | no               | no     | Capacity guard for the temporary directory                   |

The PostgreSQL data directory is provided by the deployment's local persistent Docker volume. Image files must not be written into the PostgreSQL volume or included in database backups.

## Queues and scheduling

| Variable                      | Required | Secret | Purpose                               |
| ----------------------------- | -------- | ------ | ------------------------------------- |
| `QUEUE_PREFIX`                | yes      | no     | Environment-specific BullMQ namespace |
| `GENERATION_CONCURRENCY`      | no       | no     | Text/image worker concurrency         |
| `PUBLICATION_CONCURRENCY`     | no       | no     | Telegram publication concurrency      |
| `OUTBOX_POLL_INTERVAL_MS`     | no       | no     | Outbox dispatcher interval            |
| `SCHEDULER_POLL_INTERVAL_MS`  | no       | no     | Durable schedule scan interval        |
| `SCHEDULER_LOOKAHEAD_SECONDS` | no       | no     | Occurrence materialization lookahead  |
| `PUBLICATION_MAX_ATTEMPTS`    | no       | no     | Default 5                             |

## Validation invariants

- Production requires HTTPS `API_PUBLIC_URL` and `TELEGRAM_OIDC_REDIRECT_URI`.
- `SESSION_COOKIE_SAME_SITE=none` requires `SESSION_COOKIE_SECURE=true` and non-empty exact `CORS_ALLOWED_ORIGINS`.
- `CORS_ALLOWED_ORIGINS` cannot contain `*` when browser sessions are enabled.
- Active and previous bot key IDs must differ.
- Production requires `TELEGRAM_BOT_TOKEN`; development may omit it, in which case channel
  validation returns `503 TELEGRAM_CHANNEL_VALIDATION_NOT_CONFIGURED`.
- Production requires `YOOKASSA_SHOP_ID` and `YOOKASSA_SECRET_KEY` even before payment routes are
  enabled; deployment checks only that both keys are present in `autobot-api`.
- Secret values must meet minimum length/format rules.
- A writable, non-public `IMAGE_TEMP_DIR` is required when image generation is enabled.
- `IMAGE_TEMP_DIR` must not point to the PostgreSQL data directory, repository, or a publicly served directory.
