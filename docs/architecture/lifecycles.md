# Lifecycle state machines

## Post

`Post` is a content definition; occurrence execution belongs to `Publication`.

```text
DRAFT -> ACTIVE -> ARCHIVED
  |         |
  +-------> CANCELLED
```

| From   | Command  | To        | Actor | Rule                                                                             |
| ------ | -------- | --------- | ----- | -------------------------------------------------------------------------------- |
| DRAFT  | activate | ACTIVE    | owner | Channel/topic valid and entitlement passes                                       |
| DRAFT  | cancel   | CANCELLED | owner | No new work may be created                                                       |
| ACTIVE | archive  | ARCHIVED  | owner | Existing history retained; active schedules cancelled explicitly                 |
| ACTIVE | cancel   | CANCELLED | owner | Stops new immediate/scheduled work; materialized publications handled separately |

`ARCHIVED` and `CANCELLED` are terminal. Generated/publishing progress never changes the post definition to `FAILED`.

## PostVersion

```text
GENERATION_PENDING -> GENERATING -> GENERATED -> APPROVED
          |               |            |  \----> SUPERSEDED
          |               +----------> FAILED
          +--------------------------> CANCELLED
GENERATED -> REJECTED | SUPERSEDED
```

| Transition                       | Actor                               | Rule                                               |
| -------------------------------- | ----------------------------------- | -------------------------------------------------- |
| GENERATION_PENDING -> GENERATING | generation worker                   | Atomic claim; duplicate worker sees existing state |
| GENERATING -> GENERATED          | generation worker                   | Text/media persisted before transition             |
| GENERATED -> APPROVED            | system in AUTO, owner in MODERATION | Version belongs to current publication             |
| GENERATED -> REJECTED            | owner                               | MODERATION only                                    |
| GENERATED/APPROVED -> SUPERSEDED | application service                 | A later version replaces it before publication     |
| pending/running -> FAILED        | generation worker                   | Terminal generation error persisted                |
| pending -> CANCELLED             | owner/system                        | Publication cancelled before execution             |

Version content is immutable after `GENERATED`.

## ModerationRequest

```text
PENDING -> APPROVED
       \-> REVISION_REQUESTED
       \-> REJECTED
       \-> CANCELLED
```

- One request exists per reviewed version.
- All decisions require `If-Match` and an idempotency key.
- Only the current pending request for a non-terminal publication may be decided.
- `REVISION_REQUESTED` stores feedback, supersedes the old version, and creates a new generation request/version.
- Competing decisions use an atomic state predicate; one succeeds and others receive `409 MODERATION_ALREADY_DECIDED`.

## PostSchedule

```text
ACTIVE <-> PAUSED
  |          |
  +-------> CANCELLED
  +-------> COMPLETED
```

- `COMPLETED` is automatic for exhausted one-time/COUNT/UNTIL schedules.
- `CANCELLED` is terminal.
- Pausing stops materialization only; it does not cancel existing publications.
- Editing increments `version` and recalculates `nextRunAt` transactionally.

## Publication

```text
PENDING -> GENERATING -> AWAITING_MODERATION -> READY -> PUBLISHING -> PUBLISHED
                    \-------------------------> READY
PUBLISHING -> RETRY_WAIT -> PUBLISHING
PUBLISHING -> DELIVERY_UNKNOWN
non-terminal -> FAILED | CANCELLED | SKIPPED
```

| From                  | Command/event                | To                  | Rule                                                                                  |
| --------------------- | ---------------------------- | ------------------- | ------------------------------------------------------------------------------------- |
| PENDING               | generation claimed           | GENERATING          | Worker claims atomically                                                              |
| GENERATING            | AUTO version approved        | READY               | Generated version persisted and selected                                              |
| GENERATING            | MODERATION version ready     | AWAITING_MODERATION | Pending moderation request exists                                                     |
| AWAITING_MODERATION   | approve                      | READY               | Approved version selected                                                             |
| AWAITING_MODERATION   | request revision             | GENERATING          | New version sequence and AI request created                                           |
| AWAITING_MODERATION   | reject                       | CANCELLED           | Terminal user decision                                                                |
| READY                 | publish claimed              | PUBLISHING          | Publisher claims atomically; optional image is generated into temporary local storage |
| PUBLISHING            | Telegram success             | PUBLISHED           | Chat/message identifiers and `publishedWithImage` persisted; temporary image deleted  |
| PUBLISHING            | retryable error              | RETRY_WAIT          | Attempts remain and next attempt persisted                                            |
| RETRY_WAIT            | due retry                    | PUBLISHING          | Same publication occurrence                                                           |
| PUBLISHING            | ambiguous response           | DELIVERY_UNKNOWN    | Automatic retry disabled                                                              |
| eligible non-terminal | cancel                       | CANCELLED           | Not allowed once PUBLISHING begins                                                    |
| any processing state  | terminal error               | FAILED              | Stable error code/details persisted                                                   |
| PENDING               | missed/cancelled before work | SKIPPED             | No generation or publication occurs                                                   |

`PUBLISHED`, `FAILED`, `CANCELLED`, `SKIPPED`, and `DELIVERY_UNKNOWN` are terminal for automatic processing. Manual retry of `FAILED` reopens the same publication only when the error is classified retryable and policy permits it. `DELIVERY_UNKNOWN` requires reconciliation rather than blind retry.

## Concurrency invariants

- State transitions use `WHERE id = ? AND status = ? AND version = ?` or equivalent locking.
- Queue handlers reload current durable state; job payload state is never authoritative.
- An approved version cannot be replaced after `PUBLISHING` begins.
- A publication has at most one selected/published version.
- A schedule edit cannot alter an already materialized occurrence implicitly.
- Usage reservation, domain transition, and outbox write occur in one database transaction where they form one command.
- GPT request/response messages and image content never participate in durable transitions; only final text and operational/accounting state are persisted.
