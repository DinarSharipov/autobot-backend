# Stage 4: Core domain and entitlements

## Status

Completed on 2026-10-08. Live Telegram validation remains deployment-dependent and requires the
production bot token and real channel administrator permissions.

## Objective

Implement the owned resources and policy services required before posts can be generated or published: channels, topics, subscriptions, entitlements, and usage accounting.

## Dependencies

- Stage 1 domain ownership and quota decisions.
- Stage 3 authenticated principals and authorization helpers.
- Telegram adapter credentials/configuration needed to validate channel access.

## In scope

- Channel and topic management.
- Subscription plans and active subscription state.
- Centralized entitlement evaluation.
- Concurrency-safe usage accounting.
- REST contracts consumed by both clients.

## Tasks

### 1. Channels

- Implement the `Channel` model with owner, Telegram identifiers, status, metadata, and timestamps.
- Define creation/linking behavior and verify the bot can publish to the target channel.
- Implement list, detail, create/link, update, archive/remove, and revalidation use cases.
- Enforce ownership and channel-count limits in application services.
- Keep Telegram calls behind an adapter interface.

### 2. Topics

- Implement the `Topic` model and approved relationship to users/channels.
- Implement list, detail, create, update, archive/remove, and assignment use cases.
- Enforce ownership and topic-count limits.
- Validate all references transactionally and prevent cross-user relationships.

### 3. Subscription plans

- Implement `SubscriptionPlan` and `Subscription` with effective periods and statuses.
- Seed or provision initial plans through a repeatable mechanism.
- Define deterministic behavior for absent, expired, cancelled, and replaced subscriptions.
- Expose a read model showing the current plan and effective entitlements.

### 4. Entitlements and usage

- Implement `EntitlementService` as the single policy entry point.
- Implement `UsageService` for period lookup and atomic counters/ledger operations.
- Support channel, topic, moderation/revision, and image-generation constraints.
- Add reserve, commit, and release operations for asynchronous costly work.
- Use database constraints/transactions to prevent concurrent limit overruns.
- Keep controller and queue code free from duplicated plan checks.

### 5. API and compatibility

- Expose REST operations defined in Stage 1.
- Apply consistent pagination, errors, idempotency, and authorization.
- Update OpenAPI and client integration examples.
- Preserve the same behavior regardless of whether a request originated from bot or browser.

## Deliverables

- Prisma migrations for channels, topics, subscriptions, plans, and usage.
- Channels and topics modules with Telegram validation adapter.
- Subscription, entitlement, and usage modules.
- REST/OpenAPI contracts for both clients.
- Seed/provisioning mechanism for initial plans.
- Unit and integration tests for ownership, limits, and concurrent mutations.

## Verification

- Test all channel/topic mutations under and at plan limits.
- Test concurrent create requests cannot exceed a limit.
- Test a user cannot read or reference another user's resources.
- Test Telegram channel validation success, missing permissions, timeout, and unavailable API.
- Test subscription period transitions and usage reset behavior.
- Test usage reservation commit/release and idempotent retries.

## Exit criteria

- Authenticated users can manage valid channels and topics through either client contract.
- Every limit is enforced through centralized services.
- Usage remains correct under concurrent requests and retries.
- Publication work can rely on a validated channel and a deterministic entitlement decision.

## Implemented decisions

- `free` is the default plan; `pro` and `free` are provisioned idempotently from validated,
  version-controlled definitions at application startup.
- The latest currently effective `ACTIVE` or `TRIALING` subscription wins. Absent, future,
  expired, cancelled, and past-due subscriptions fall back to the active default plan.
- Resource counts include all non-archived channels/topics. Creation checks run with the insert in
  a serializable PostgreSQL transaction and retry serialization failures.
- Channel create/revalidation calls Telegram through `TelegramChannelAdapter` and stores only chat
  metadata and an allowlisted permission summary.
- Creation and revalidation commands use a durable, principal-and-operation-scoped idempotency
  record. Reusing a key with a different request returns `IDEMPOTENCY_KEY_REUSED`.
- Usage uses UTC calendar months. `reserve`, `commit`, and `release` append idempotent ledger entries
  and atomically mutate the monthly counter in serializable transactions.
- Topics are user-owned reusable inputs and may be referenced by any channel/post owned by the same
  user; there is intentionally no separate topic-channel assignment table in MVP.

## Migration and compatibility

- Migration `20261008140000_core_domain_entitlements` additively introduces durable idempotency
  records and scopes usage operation-key uniqueness to a monthly counter.
- The migration is compatible with the Stage 3 application: no existing table or column is removed,
  and the previous globally unique usage key constraint is only relaxed.
- Normal rollback is application rollback without database rollback. The added table and relaxed
  index may remain until a later forward cleanup migration.

## Main risks

- Simple read-then-increment counters can exceed quotas under concurrency.
- Mixing Telegram transport metadata with domain ownership can make channel migration difficult.
- Hard-coding plans in controllers would make bot and Web Admin behavior diverge.
