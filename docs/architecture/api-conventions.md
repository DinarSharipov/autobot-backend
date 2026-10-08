# REST API conventions

## Boundary

- Base path: `/api/v1`.
- Browser base URL: public HTTPS origin configured by Web Admin.
- Bot base URL: `http://autobot-api:3000` on `autobot-shared`.
- The same user-scoped resources and application services serve both clients.
- Browser requests use the session cookie; bot requests use the HMAC scheme from ADR 0003.

## Representation

- Media type: `application/json` unless an endpoint explicitly redirects or streams media.
- Property naming: `camelCase`.
- IDs: UUID strings. Telegram 64-bit identifiers are decimal strings.
- Time instants: RFC 3339 UTC strings, for example `2026-10-08T09:30:00Z`.
- User time zones: IANA identifiers, for example `Europe/Moscow`.
- Optional absent values are omitted where possible; explicit clearing uses `null` only where the schema permits it.
- Unknown request properties are rejected.

## Response envelopes

Single resource:

```json
{
  "data": {}
}
```

Cursor-paginated collection:

```json
{
  "data": [],
  "page": {
    "nextCursor": "opaque-or-null",
    "hasMore": false
  }
}
```

Commands returning asynchronous work use `202 Accepted` and return the current resource plus its durable status. Creation without asynchronous continuation uses `201 Created`.

## Errors

```json
{
  "error": {
    "code": "POST_STATE_CONFLICT",
    "message": "The post cannot be approved from its current state.",
    "details": {},
    "requestId": "01J..."
  }
}
```

The stable machine-readable `code` drives client behavior. `message` is safe for display but is not a localization key contract. `details` must not include secrets, provider payloads, stack traces, or private infrastructure values.

Status usage:

- `400` malformed request or invalid syntax.
- `401` missing/invalid authentication or expired session.
- `403` authenticated but forbidden, including entitlement denial.
- `404` resource absent or intentionally hidden by ownership rules.
- `409` idempotency mismatch, stale version, duplicate, or illegal state transition.
- `422` semantically invalid domain input.
- `429` request/service rate limit.
- `502` eligible upstream provider failure surfaced synchronously.
- `503` required dependency unavailable.

## Pagination and filtering

- Use opaque keyset cursors, never public offset pagination for unbounded collections.
- Default page size is 25; maximum is 100.
- Stable default ordering is `createdAt DESC, id DESC` unless documented otherwise.
- `sort` values are endpoint allowlists, not raw database expressions.
- Date ranges use inclusive `from` and exclusive `to`.

## Idempotency

`Idempotency-Key` is required for commands that create costly work or external side effects:

- create a post/publication request;
- request a revision;
- approve/reject moderation;
- manually retry a publication;
- create or materially change a schedule when a duplicate could create occurrences.

Keys are scoped to authenticated principal plus operation, are 16–128 printable ASCII characters, and are retained for at least 24 hours. Reuse with a different request digest returns `409 IDEMPOTENCY_KEY_REUSED`.

## Optimistic concurrency

Mutable aggregates expose an integer `version`. PATCH and lifecycle commands send `If-Match: "<version>"`. A stale value returns `409 STALE_RESOURCE_VERSION` and the client must refetch.

## Correlation

- Accept an optional valid `X-Request-Id`; otherwise generate one.
- Return `X-Request-Id` on every API response.
- Propagate request ID, aggregate ID, publication ID, and job ID into structured logs and queue metadata.

## Compatibility

- Additive optional fields and new endpoints are backward compatible.
- Existing enum values are open sets for clients; clients must show an unknown-safe fallback.
- Removing/renaming fields, changing meaning, making optional input required, or adding a required response assumption needs a new API version or coordinated migration.
- Database migrations use expand/migrate/contract sequencing for independently deployed clients.
- OpenAPI changes are reviewed in CI; generated clients are versioned by their own repositories.
