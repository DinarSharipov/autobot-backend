# Stage 5: Publication pipeline

## Objective

Deliver the complete durable content lifecycle: generation, versioning, moderation, immediate and scheduled execution, image generation, retries, and direct Telegram publication.

## Dependencies

- Stage 1 lifecycle, scheduling, media, and queue decisions.
- Stage 2 database/queue infrastructure.
- Stage 4 validated channels and centralized entitlement/usage services.
- Configured AI and Telegram adapters plus a restricted temporary image directory.

## In scope

- Posts, versions, moderation requests, schedules, publications, and AI requests.
- Text/image generation adapters and queue jobs.
- No persistence of GPT conversation transcripts or image content.
- AUTO and MODERATION policies.
- Immediate, one-time scheduled, and recurring publication.
- Idempotency, retries, recovery, and publication history.

## Tasks

### 1. Domain persistence and state transitions

- Implement `Post`, `PostVersion`, `ModerationRequest`, `PostSchedule`, `Publication`, and `AIRequest`.
- Represent lifecycle changes through application services, not direct controller/processor updates.
- Enforce legal transitions with transactions and optimistic or explicit concurrency control.
- Preserve immutable historical versions and publication results.
- Store one publication occurrence/result independently from the reusable post and schedule.

### 2. Reliable job dispatch

- Define versioned typed payloads for `GeneratePost`, `PublishPost`, `ScheduledPublish`, `RecurringPublish`, and `RetryPublication`.
- Run optional image generation inside `PublishPost` immediately before Telegram upload; never pass image bytes or paths through BullMQ/Redis.
- Implement the approved transactional outbox or equivalent database-backed dispatch mechanism.
- Use deterministic BullMQ job IDs and domain idempotency keys.
- Make every processor safe under at-least-once delivery.
- Persist terminal failure before acknowledging jobs.
- Add reconciliation for durable work that exists in PostgreSQL but is absent from queues.

### 3. Text and image generation

- Implement provider-neutral AI adapter interfaces.
- Persist request status and accounting metadata without storing provider prompts, messages, raw responses, or conversation history.
- Reserve entitlement/usage before expensive execution and commit/release it atomically after the result.
- Persist generated text as a new `PostVersion`.
- Treat `PostVersion.text` as the final post artifact, not a copy of the provider conversation.
- Generate an optional image only after AUTO text is ready or MODERATION text is approved.
- Write image bytes only to the configured restricted temporary directory.
- Delete the temporary image after Telegram upload, terminal failure/cancellation, or TTL expiry.
- Do not persist image bytes, base64, provider URLs, local paths, or media records in PostgreSQL.
- Make image regeneration on retry idempotent for user quota accounting.
- Normalize provider errors into retryable and terminal categories.

### 4. Immediate AUTO flow

- Create a post command with channel, topic, source/prompt, and publication policy.
- Generate and persist a version.
- For AUTO, dispatch publication after successful generation.
- Publish directly through the Telegram publisher adapter.
- Persist Telegram message identifiers, timestamps, and normalized result/error data.
- Persist only whether the final Telegram publication included an image, not the image itself.
- Prevent duplicate Telegram messages when a job or HTTP request is retried.

### 5. MODERATION flow

- Move a generated version into the waiting-for-moderation state.
- Implement approve, reject/cancel, and request-revision commands.
- Create a new immutable version for each revision.
- Reject actions against stale or already finalized versions.
- Continue to publication only after valid approval.
- Expose the same persisted moderation state to both clients.

### 6. One-time and recurring scheduling

- Implement schedule creation, update, pause, resume, and cancellation.
- Dispatch due one-time occurrences from durable database state.
- Materialize each recurring occurrence with a unique key.
- Apply the approved timezone, daylight-saving, and missed-run policies.
- Recalculate future occurrences safely after schedule edits.
- Ensure restart/reconciliation cannot lose or duplicate occurrences.

### 7. Telegram publication adapter

- Encapsulate Telegram Bot API calls outside application/domain services.
- Support the approved text, formatting, image, and media combinations.
- Verify channel status before publication where policy requires it.
- Classify permission, validation, rate-limit, network, and server errors.
- Respect retry-after information without blocking application threads.
- Never route background publication through the grammY application.

### 8. Query API

- Expose post/version detail and history.
- Expose moderation queues and actions.
- Expose schedules and calendar-oriented occurrence queries.
- Expose publication history and failure details safe for end users.
- Keep read models efficient with pagination and database indexes.

## Recommended delivery slices

1. Post/version persistence and immediate text-only AUTO publication.
2. MODERATION approval and revision flow.
3. One-time scheduling.
4. Recurring scheduling and reconciliation.
5. Ephemeral image generation and Telegram publication.
6. Operational retry and history endpoints.

Each slice should be deployable and tested before the next one begins.

## Deliverables

- Domain modules and Prisma migrations for the complete lifecycle.
- AI and Telegram adapters plus temporary-image cleanup implementation.
- BullMQ producers/processors and reliable dispatch/reconciliation.
- REST/OpenAPI operations for creation, moderation, schedules, calendar, and history.
- Tests covering state transitions, idempotency, retries, and restart recovery.

## Verification

- Complete immediate AUTO and MODERATION flows from HTTP request to recorded Telegram result.
- Retry each HTTP command and each job and prove there is no duplicate version, occurrence, charge, or message.
- Restart the API between database commit, enqueue, generation, approval, and publication steps.
- Test simultaneous approval/revision/cancellation requests.
- Test AI and Telegram timeouts, rate limits, invalid content, missing permissions, and terminal failures.
- Test that provider conversation payloads and image content/paths never enter PostgreSQL or logs.
- Test temporary-image deletion after success, failure, cancellation, restart, and TTL expiry.
- Test one-time and recurring schedules across timezone/DST boundaries selected in Stage 1.
- Verify all durable state remains inspectable when Redis is flushed or temporarily unavailable.

## Exit criteria

- All approved MVP publication modes work through one shared backend contract.
- PostgreSQL contains enough state to reconcile unfinished work after a restart.
- Queue retries cannot duplicate external side effects or usage charges.
- Bot and Web Admin observe the same moderation, schedule, and publication state.
- Provider-specific logic remains behind adapters.

## Main risks

- BullMQ job uniqueness alone cannot guarantee exactly-once Telegram side effects.
- Updating domain state and enqueueing separately can lose work without durable dispatch/reconciliation.
- Recurring schedules become incorrect if timezone and edit semantics are left implicit.
- Temporary files can leak or fill local disk without strict cleanup, permissions, and capacity limits.
- Image review before publication is intentionally unavailable because images are not stored durably.
