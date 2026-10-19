# Domain model

> Product decision (2026-10-19): [Generation packs and prepaid balances](../GENERATION_PACKS_PLAN.md) supersedes subscription tiers/monthly quotas and the old exclusion of image preview. The transition is planned, not implemented. Legacy behavior and historical verification below must not be treated as the new billing contract.

## Aggregate boundaries

- `User` owns identity, channels, topics, posts, sessions, wallets, purchases, and usage.
- `Post` is a reusable content definition. It is not a publication attempt.
- `PostVersion` is immutable generated/revised content.
- `PostSchedule` describes when publication occurrences should be materialized.
- `Publication` is one durable immediate or scheduled occurrence and owns its execution state.
- `ModerationRequest` records a decision for one version in one publication occurrence.
- `AIRequest`, `OutboxEvent`, and `AuditEvent` are durable supporting records.
- GPT conversation transcripts and image content are not persistence entities.

## ER diagram

```mermaid
erDiagram
    User ||--o| TelegramAccount : has
    User ||--o{ AuthIdentity : authenticates
    TelegramAccount ||--o{ AuthIdentity : backs
    User ||--o{ Session : owns
    User ||--o{ Channel : owns
    User ||--o{ Topic : owns
    User ||--o{ Post : owns
    Channel ||--o{ Post : targets
    Topic o|--o{ Post : guides
    Post ||--o{ PostVersion : versions
    Post ||--o{ PostSchedule : schedules
    Post ||--o{ Publication : occurrences
    PostSchedule o|--o{ Publication : materializes
    Publication ||--o{ PostVersion : generates
    Publication ||--o{ ModerationRequest : reviews
    PostVersion ||--o| ModerationRequest : reviewed_by
    Publication o|--o| PostVersion : publishes
    User ||--o{ GenerationWallet : owns
    GenerationWallet ||--o{ CreditLedgerEntry : records
    User ||--o{ PurchaseOrder : purchases
    GenerationPack ||--o{ PurchaseOrder : snapshots
    PurchaseOrder ||--o{ PaymentEvent : reconciles
    Publication ||--o| TextRevisionAllowance : includes
    User ||--o{ UsageCounter : tracks
    User ||--o{ IdempotencyRecord : scopes
    UsageCounter ||--o{ UsageLedgerEntry : records
    User ||--o{ AIRequest : incurs
    Publication o|--o{ AIRequest : triggers
    Post o|--o{ AIRequest : relates
```

## Identity responsibilities

| Entity            | Responsibility                                         | Key uniqueness                                        |
| ----------------- | ------------------------------------------------------ | ----------------------------------------------------- |
| `User`            | Internal identity, status, locale, timezone            | UUID primary key                                      |
| `TelegramAccount` | Canonical numeric Telegram account and mutable profile | `telegramUserId` globally unique; one per user in MVP |
| `AuthIdentity`    | External login subject                                 | `(provider, subject)` unique                          |
| `Session`         | Revocable browser session                              | `secretHash` unique                                   |

## Ownership

- MVP is single-user, not organization/team based.
- Every user-scoped query includes ownership in the database predicate; fetching by ID and checking afterward is discouraged.
- A Telegram channel is linked to one Autobot user in MVP. Reassignment is an explicit audited operation, not a second create.
- Topics belong to a user and may be used with any channel owned by that same user.
- Post references must point to channel/topic records owned by the post owner.

## Persistence rules

- Application IDs are UUIDs. Telegram IDs use PostgreSQL `BIGINT` and JSON decimal strings.
- All mutable aggregates have `createdAt`, `updatedAt`, and integer `version` where concurrent commands matter.
- Historical versions, moderation decisions, publications, usage ledger entries, and audit events are append-only except for narrowly defined status transitions.
- User-facing deletes archive/soft-delete referenced records. Hard deletion is a retention operation.
- `PostVersion.text` is immutable after generation; revisions create a new sequence.
- `PostVersion.text` is the final product artifact, not a provider conversation transcript.
- Raw provider messages/responses and generated image bytes, URLs, or filesystem paths are never stored in PostgreSQL.
- `AIRequest` contains accounting/operational metadata only and no content payload.
- Each schedule occurrence is unique by `(scheduleId, scheduledFor)`.
- Each idempotent command is unique by principal, operation, and idempotency key in the idempotency store introduced during implementation.
- Outbox rows are written in the domain transaction and may be retried until delivered.

## Prepaid balances and generation allowances (target, pending)

- Separate TEXT/IMAGE wallets have available and reserved integer balances with no monthly reset.
- Purchased packs are snapshotted in orders; verified successful payments grant credits once.
- One initial TEXT generation grants three included successful revisions for its generated occurrence.
  Further revisions debit one TEXT without resetting the included allowance.
- Every successful image generation/replacement debits one IMAGE. Publication reuses selected media.
- Ledger and reserve/commit/release operations are idempotent and concurrency-safe.
- Global active channel/topic caps are independent of pack size and paid tiers.
- See [generation pack plan](../GENERATION_PACKS_PLAN.md) for migration and payment invariants.
- Existing Subscription/SubscriptionPlan/monthly UsageCounter schema is legacy until migration.

## Audit policy

Persist `AuditEvent` for security- and lifecycle-sensitive actions:

- login/logout/session revocation and identity-link conflict;
- channel link/revalidation/removal;
- subscription/entitlement administrative changes;
- moderation approve/reject/revision;
- schedule create/update/pause/resume/cancel;
- manual publication retry/cancel.

Routine reads and internal polling are not audited. Audit metadata is allowlisted and must not contain secrets, prompts, generated content, provider responses, image references, or provider credentials.

## Prisma proposal

[`prisma-model-proposal.prisma`](./prisma-model-proposal.prisma) is the Stage 2 starting point, not a generated/runtime schema. Stage 2 may make syntax/index adjustments, but changes to ownership, uniqueness, or aggregate meaning require an architecture update.
