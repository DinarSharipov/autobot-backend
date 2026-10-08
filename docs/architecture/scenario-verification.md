# Stage 1 scenario verification

These walkthroughs validate that the contracts cover the approved MVP flows and failure boundaries.

## Immediate AUTO

1. Authenticated client creates a post with `publicationMode=AUTO` and no schedule using an idempotency key.
2. Backend validates ownership/entitlement, creates `Post`, `Publication(PENDING)`, usage reservation, and outbox event transactionally.
3. Generation worker creates a final-text `PostVersion`, records content-free `AIRequest` accounting metadata, commits/releases usage, and moves the publication to `READY`.
4. If requested, the publishing worker generates an image into the restricted temporary directory after the text is ready/approved.
5. Publisher uploads text/image through the Telegram adapter, records only chat/message IDs and `publishedWithImage`, then deletes the temporary file.
6. Duplicate HTTP requests/jobs return/reuse the same durable resources and do not double consume image quota.

Result: no client performs generation or Telegram publication directly.

## MODERATION with revision

1. Generation produces version 1 and a pending moderation request.
2. Bot or Web Admin requests a revision with `If-Match` and an idempotency key.
3. Version 1/request become terminal; version 2 and a new AI request are created transactionally.
4. The other client reads the same publication and sees version 2/current moderation state.
5. Approval selects version 2; a concurrent stale approval of version 1 receives `409`.
6. An optional image is generated only after approval; image preview during moderation is outside MVP.

Result: immutable history is retained and competing decisions cannot both win.

## One-time schedule

1. Client creates a UTC instant plus display timezone.
2. Scheduler materializes a unique publication/outbox event near `runAt`.
3. A restart after database commit but before BullMQ insertion leaves a pending outbox row.
4. Reconciler enqueues the missing job.
5. A second scheduler instance hits the unique occurrence constraint and does not duplicate work.

Result: neither API restart nor concurrent schedulers lose/duplicate the occurrence.

## Recurring schedule

1. Client submits supported RRULE and IANA timezone.
2. Backend calculates and stores `nextRunAt` in UTC.
3. Each scan materializes one uniquely keyed occurrence and advances `nextRunAt` in the same transaction.
4. After downtime, `LATEST_ONLY` creates at most one catch-up inside the grace period and skips older runs.
5. DST resolution follows the documented wall-clock rules.

Result: Redis does not own recurrence state and recovery cannot create an unbounded publication burst.

## Duplicate and retry safety

- Duplicate command with same key/body returns the original result.
- Same key with different body returns `409 IDEMPOTENCY_KEY_REUSED`.
- Duplicate generation job observes current version/publication state and exits or resumes safely.
- Retryable publication errors update the same `Publication` and schedule another attempt.
- Ambiguous Telegram delivery becomes `DELIVERY_UNKNOWN`, not a blind automatic retry.
- Usage reserve/commit/release uses unique operation keys and cannot double charge.

## Identity and security

- Browser OIDC `sub` and numeric Telegram `id` resolve to one user/Telegram account.
- A conflicting existing mapping returns `IDENTITY_LINK_CONFLICT` without auto-merge.
- Bot request without valid HMAC cannot assert `X-Telegram-User-Id`.
- Replayed HMAC nonce or stale timestamp is rejected.
- Browser mutation without valid CSRF token is rejected even with a session cookie.
- An allowed Web origin receives credentialed CORS; an unknown origin does not.

## Dependency failures

| Failure                                    | Expected behavior                                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| PostgreSQL unavailable                     | Readiness fails; domain commands do not proceed                                                                                      |
| Redis unavailable                          | Readiness/degraded policy reports failure; bot HMAC fails closed; established sessions remain in PostgreSQL; new jobs wait in outbox |
| AI timeout                                 | Retry or terminal classification persisted; reserved usage is not double charged                                                     |
| Telegram rate limit                        | Respect `retry_after`; same publication is retried                                                                                   |
| Telegram permission revoked                | Publication fails terminally and channel becomes eligible for revalidation                                                           |
| Temporary image directory unavailable/full | Image publication fails safely; no image bytes/path enter PostgreSQL                                                                 |
| Worker stops with a temporary image        | Startup/periodic TTL cleanup removes orphan files; eligible retry regenerates without duplicate quota consumption                    |

## Client/network boundary

- Bot uses `http://autobot-api:3000` only on `autobot-shared`.
- Web Admin uses configurable public HTTPS and never joins backend Docker networks.
- PostgreSQL and Redis are not exposed to either client.
- Cross-client visibility is achieved by committed PostgreSQL state plus refetch/polling; realtime is not required for MVP correctness.
