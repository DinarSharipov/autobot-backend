# ADR 0004: PostgreSQL-backed scheduling and at-least-once queues

- Status: Accepted
- Date: 2026-10-08

## Context

BullMQ is reliable execution infrastructure but Redis is not the source of truth. Database commits and queue insertion cannot be treated as one atomic operation without an explicit pattern.

## Decision

- Persist posts, schedules, publication occurrences, state transitions, and usage accounting in PostgreSQL.
- Use a transactional outbox written in the same transaction as each domain change that requires background work.
- An outbox dispatcher publishes BullMQ jobs and marks outbox records delivered. A reconciler retries pending/stale records.
- Assume at-least-once delivery. Every processor must be idempotent and use deterministic job IDs.
- A `Publication` is the durable occurrence record for immediate and scheduled work.
- Recurring schedules materialize one `Publication` per occurrence with a unique `(scheduleId, scheduledFor)` constraint.
- Telegram publication stores the resulting chat/message identifier before acknowledging success.
- Redis loss may delay work but must not erase domain state; queues are reconstructed from PostgreSQL/outbox state.
- Workers initially run in the API process behind modules that can be bootstrapped separately later.
- Image generation runs inside the publication processor immediately before Telegram upload. Image bytes are not passed through BullMQ, Redis, PostgreSQL, or a separate durable image job.
- Retry classification is explicit: validation/permission/content errors are terminal; timeouts, rate limits, and eligible upstream 5xx errors are retryable.

## Consequences

- Queue job uniqueness is an optimization, not the only duplicate protection.
- Operational tooling can reconcile pending work after API or Redis failure.
- Exactly-once external delivery is not claimed; duplicate risk at an ambiguous Telegram timeout must be visible and handled conservatively.
