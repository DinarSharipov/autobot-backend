# ADR 0003: HMAC authentication for bot-to-backend requests

- Status: Accepted
- Date: 2026-10-08

## Context

The bot sends requests over an internal Docker network and asserts a Telegram user context. Network location and a Telegram user ID alone do not authenticate the caller.

## Decision

- Authenticate every bot request with HMAC-SHA-256 using a dedicated shared service key, independent from `TELEGRAM_BOT_TOKEN`.
- Required headers:
  - `X-Autobot-Service: autobot-bot`
  - `X-Autobot-Key-Id`
  - `X-Autobot-Timestamp` as Unix seconds
  - `X-Autobot-Nonce` as a UUID
  - `X-Autobot-Signature: v1=<lowercase hex digest>`
  - `X-Telegram-User-Id` as a decimal string for user-scoped API calls
- Sign this UTF-8 canonical value:

```text
<UPPERCASE_METHOD>\n
<PATH_WITH_CANONICAL_QUERY>\n
<LOWERCASE_HEX_SHA256_BODY>\n
<TIMESTAMP>\n
<NONCE>\n
<TELEGRAM_USER_ID_OR_EMPTY>
```

- Query parameters are sorted by encoded key and value. The body digest is the SHA-256 of the exact transmitted bytes; an empty body is hashed as zero bytes.
- Reject timestamps outside a configurable 60-second skew.
- Store nonce keys in Redis with `SET NX` for five minutes and reject reuse. Redis unavailability fails bot authentication closed.
- Support an active and a previous key ID during rotation. Unknown or retired key IDs are rejected.
- Compare signatures in constant time.
- Only after service authentication succeeds may the API resolve `X-Telegram-User-Id` to an application user.
- Service credentials authorize the bot transport; they do not bypass user ownership or entitlement rules.

## Canonicalization test vector

This public fixture is for contract tests only and must never be used as a deployed secret.

```text
secret: test-secret-32-bytes-long-1234567890
method: POST
path with canonical query: /api/v1/internal/telegram-users/resolve
body: {"firstName":"Dinar","username":"dinar"}
body SHA-256: 9b2dddabe41572caf13a3b17a95895fe31ea4b5a8a8d2263c3bfc8a7baea5dcf
timestamp: 1791446400
nonce: 123e4567-e89b-42d3-a456-426614174000
Telegram user ID: 123456789
signature: v1=d634028aa8874b6fb90ae13f8eb02b92705ced5cd3ec802ef59ca5154aef0196
```

The canonical UTF-8 value contains exactly five LF separators and no trailing newline.

## Consequences

- Captured requests cannot be replayed after nonce/timestamp validation.
- Bot and browser can call the same user-scoped application services through different authentication guards.
- Both repositories must share canonicalization test vectors before integration.
