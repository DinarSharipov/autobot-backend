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

| Variable                       | Required   | Secret | Purpose                                       |
| ------------------------------ | ---------- | ------ | --------------------------------------------- |
| `TELEGRAM_OIDC_ISSUER`         | yes        | no     | Expected issuer; `https://oauth.telegram.org` |
| `TELEGRAM_OIDC_CLIENT_ID`      | yes        | no     | Client ID provided by BotFather               |
| `TELEGRAM_OIDC_CLIENT_SECRET`  | yes        | yes    | OIDC code-exchange secret                     |
| `TELEGRAM_OIDC_REDIRECT_URI`   | yes        | no     | Registered backend callback URL               |
| `TELEGRAM_OIDC_SCOPES`         | yes        | no     | MVP value `openid profile`                    |
| `OIDC_FLOW_TTL_SECONDS`        | no         | no     | State/PKCE record TTL; default 600            |
| `OIDC_REQUEST_TIMEOUT_MS`      | no         | no     | Telegram token/JWKS request timeout           |
| `SESSION_COOKIE_NAME`          | no         | no     | Default `__Host-autobot_session`              |
| `SESSION_ABSOLUTE_TTL_SECONDS` | no         | no     | Default 2592000 (30 days)                     |
| `SESSION_IDLE_TTL_SECONDS`     | no         | no     | Default 604800 (7 days)                       |
| `SESSION_COOKIE_SAME_SITE`     | production | no     | `lax` or `none` from deployed topology        |
| `SESSION_COOKIE_SECURE`        | production | no     | Must be `true` in production                  |

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

| Variable                | Required         | Secret | Purpose                                                                                 |
| ----------------------- | ---------------- | ------ | --------------------------------------------------------------------------------------- |
| `AI_TEXT_PROVIDER`      | text generation  | no     | Selected provider adapter                                                               |
| `AI_TEXT_MODEL`         | text generation  | no     | Provider model identifier                                                               |
| `AI_TEXT_API_KEY`       | text generation  | yes    | Provider credential                                                                     |
| `AI_IMAGE_PROVIDER`     | image generation | no     | Selected provider adapter                                                               |
| `AI_IMAGE_MODEL`        | image generation | no     | Provider model identifier                                                               |
| `AI_IMAGE_API_KEY`      | image generation | yes    | Provider credential; may equal text key operationally but remains separately configured |
| `AI_REQUEST_TIMEOUT_MS` | no               | no     | Upstream timeout                                                                        |

Provider-specific optional settings use a documented adapter prefix and must not leak into domain contracts.

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
- Secret values must meet minimum length/format rules.
- A writable, non-public `IMAGE_TEMP_DIR` is required when image generation is enabled.
- `IMAGE_TEMP_DIR` must not point to the PostgreSQL data directory, repository, or a publicly served directory.
