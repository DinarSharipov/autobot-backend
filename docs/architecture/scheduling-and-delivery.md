# Scheduling and delivery semantics

## Schedule types

### One-time

- Stores `runAt` as a UTC instant and the user's IANA time zone for display/audit.
- Default misfire policy is `FIRE_ONCE` with a 24-hour grace period.
- If recovery occurs outside the grace period, the occurrence becomes `SKIPPED`.
- A completed one-time schedule cannot be resumed; rescheduling creates or explicitly updates a not-yet-materialized schedule.

### Recurring

- Stores an RFC 5545 RRULE subset plus an IANA time zone.
- MVP recurrence supports `DAILY`, `WEEKLY`, and `MONTHLY`, `INTERVAL`, `BYDAY`, `BYMONTHDAY`, `COUNT`, and `UNTIL`.
- Unsupported RRULE parts are rejected instead of interpreted approximately.
- `nextRunAt` is materialized in UTC and recalculated transactionally after each occurrence.
- Default misfire policy is `LATEST_ONLY` with a six-hour grace period. Recovery creates at most one catch-up occurrence and skips older missed occurrences.

## Daylight-saving behavior

- Recurrences preserve the configured local wall-clock time.
- If a local time does not exist during a forward transition, use the first valid instant after the gap.
- If a local time occurs twice during a backward transition, use the earlier instant and create only one occurrence.
- The resolved UTC `scheduledFor` is persisted so later time-zone database updates do not rewrite history.

## Materialization

- A scheduler loop queries active schedules whose `nextRunAt` is within a configurable lookahead.
- Claim rows transactionally with database locking suitable for multiple scheduler instances.
- Create one `Publication` using unique `(scheduleId, scheduledFor)` and write its outbox event in the same transaction.
- Advance `nextRunAt` in that transaction.
- `Publication` is also the occurrence record; a separate Redis-only occurrence does not exist.

## Editing and cancellation

- Schedule mutations require `If-Match` with the current version.
- Edits affect only occurrences not yet materialized.
- A materialized `PENDING`, `GENERATING`, `AWAITING_MODERATION`, `READY`, or `RETRY_WAIT` publication must be explicitly cancelled if the user wants it stopped.
- `PUBLISHING` and `PUBLISHED` cannot be cancelled.
- Pausing prevents new materialization but does not silently cancel existing publications.
- Cancelling a schedule is terminal and preserves history.

## Retry policy

- Default publication attempts: five.
- Default backoff: 5 seconds, 30 seconds, 2 minutes, 10 minutes, 30 minutes, with jitter.
- Telegram `retry_after` takes precedence when longer than calculated backoff.
- Retryable: connection timeout/reset, rate limit, and eligible upstream 5xx responses.
- Terminal: invalid content, unknown/removed chat, insufficient bot rights, ownership failure, and entitlement rejection before work begins.
- Manual retry creates a new attempt on the same `Publication`; it does not create a second occurrence.

## Ambiguous Telegram outcomes

If the connection fails after Telegram may have accepted a request but before a response is received, the result is `DELIVERY_UNKNOWN`. Automatic retry is disabled unless a provider-supported deduplication mechanism exists for that method. The publication is surfaced for operator/user reconciliation to avoid silently producing duplicates.

## Formatting baseline

- MVP stores generated canonical text separately from provider input.
- The Telegram adapter initially supports plain text and the approved safe HTML subset.
- Text-only publication uses `sendMessage`; a single generated image with caption uses `sendPhoto`.
- Image generation occurs after text approval and immediately before publication. The file is temporary local worker data and is deleted after upload or terminal cleanup.
- Image bytes, local paths, provider URLs, and GPT request/response transcripts are never persisted in PostgreSQL.
- Image preview/moderation before publication is outside MVP.
- Media groups, video, documents, rich messages, and paid broadcasts require later contract extensions.
- Telegram Bot API behavior is isolated behind the publisher adapter and verified against the current [official Bot API](https://core.telegram.org/bots/api).
