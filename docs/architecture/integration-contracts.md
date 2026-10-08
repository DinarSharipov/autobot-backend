# Client integration contracts

## Shared principles

- Backend state is authoritative.
- Clients do not reproduce entitlement or lifecycle rules.
- Both clients consume `/api/v1` and stable error codes.
- OpenAPI is the source for generated DTO/client types; backend domain classes are not shared packages.
- MVP consistency is persisted/read-after-write consistency, not a realtime push guarantee.

## grammY bot

### Connection

- Base URL: `BACKEND_URL`, production value `http://autobot-api:3000`.
- Authenticate every request using ADR 0003 HMAC headers.
- User-scoped calls include the Telegram numeric user ID as a decimal string.
- The bot must not forward arbitrary client-supplied values into signed identity headers.

### Behavior

- Resolve/onboard a user through `POST /api/v1/internal/telegram-users/resolve` before user-scoped flows.
- Use `Idempotency-Key` for callback actions and commands that may be delivered more than once.
- Set short HTTP timeouts; retry only safe reads or idempotent commands with the same key.
- Render backend `error.code` through a bot-owned localization map, with a generic fallback.
- Poll active generation/moderation/publication state when the conversation needs progress; do not maintain authoritative local state.

### Required contract tests

- Shared HMAC canonicalization vectors.
- Telegram 64-bit ID serialization as string.
- Duplicate callback/idempotency behavior.
- Mapping of authentication, entitlement, transition, validation, and dependency errors.

## Web Admin

### Connection

- Base URL comes from build/runtime environment and uses public HTTPS in production.
- Send `credentials: "include"` for session-bound calls.
- Never store an application authentication token in localStorage/sessionStorage.
- Obtain a CSRF token from `/api/v1/auth/csrf` and send it on mutations.
- The backend CORS allowlist contains exact deployed origins only.

### Login

1. Navigate the browser to `/api/v1/auth/telegram/start?returnTo=<allowed URL>`.
2. Backend redirects to Telegram OIDC with state and PKCE.
3. Telegram redirects to the backend callback.
4. Backend validates/exchanges the code, creates the session cookie, and redirects to the validated Web Admin URL.
5. Web Admin calls `/api/v1/auth/session` to bootstrap authenticated state.

### State refresh

- Invalidate/refetch affected queries after mutations.
- Refetch on window focus and network reconnect.
- Poll active jobs/moderation views at a bounded interval (recommended five seconds) until terminal state.
- Treat unknown enum values as displayable unsupported states rather than crashing.
- Realtime transport may be added later without changing persisted REST contracts.

## OpenAPI consumption

- Backend CI validates `docs/openapi/openapi.yaml` and compares implementation output once controllers exist.
- Client repositories generate or wrap their clients from a pinned backend contract revision.
- Client deployments must tolerate additive fields and unknown enum values.
- Breaking changes require a new version or coordinated expand/migrate/contract release.

## Core-domain request examples

Browser mutations send both the session cookie and CSRF token. Creation commands also keep the
same idempotency key across transport retries:

```ts
const response = await fetch(`${apiUrl}/api/v1/topics`, {
  method: 'POST',
  credentials: 'include',
  headers: {
    'Content-Type': 'application/json',
    'Idempotency-Key': crypto.randomUUID(),
    'X-CSRF-Token': csrfToken,
  },
  body: JSON.stringify({ name: 'Product news', promptTemplate: 'Write a concise update.' }),
});
```

Updates and archive commands send the quoted version returned by the preceding read:

```ts
await fetch(`${apiUrl}/api/v1/topics/${topic.id}`, {
  method: 'PATCH',
  credentials: 'include',
  headers: {
    'Content-Type': 'application/json',
    'If-Match': `"${topic.version}"`,
    'X-CSRF-Token': csrfToken,
  },
  body: JSON.stringify({ description: 'Daily product changes' }),
});
```

The bot uses the same resource paths and bodies, but authenticates every request with the ADR 0003
HMAC headers and omits `X-CSRF-Token`. Clients read limits from `GET /subscription` and current
calendar-month counters from `GET /usage`; they must treat the backend's entitlement errors as
authoritative.
