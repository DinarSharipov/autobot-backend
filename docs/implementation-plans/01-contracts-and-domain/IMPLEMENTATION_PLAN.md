# Stage 1: Contracts and domain design

## Status

Completed on 2026-10-08. The accepted baseline is indexed in [`../../architecture/README.md`](../../architecture/README.md), with the initial REST contract in [`../../openapi/openapi.yaml`](../../openapi/openapi.yaml).

## Objective

Remove architectural ambiguity before scaffolding the application. Define stable boundaries shared by the backend, grammY bot, and separately deployed Web Admin.

## Dependencies

- Current `docs/AGENTS.md` architecture rules.
- Read-only inspection of the current `DinarSharipov/autobot` integration behavior.
- Confirmed or proposed production domain topology for the API and Web Admin.

## In scope

- REST API conventions and versioning.
- Browser and bot authentication contracts.
- Domain ownership and persistence model.
- Lifecycle state machines.
- Scheduling, quota, media, and failure semantics.

## Tasks

### 1. API boundary

- Define the `/api/v1` route structure.
- Define request validation, pagination, filtering, sorting, error, and correlation ID formats.
- Separate browser session endpoints from internal bot authentication.
- Identify commands that require an idempotency key.
- Draft OpenAPI operations needed by both clients.
- Define API compatibility and deprecation rules for independently deployed clients.

### 2. Identity and authorization

- Define the responsibilities of `User`, `AuthIdentity`, and `TelegramAccount` without duplicating identity ownership.
- Define how bot-originated Telegram users resolve to the same `User` as browser login.
- Select and document bot-to-API service authentication.
- Define the Telegram browser login validation flow.
- Define session creation, storage, expiry, rotation, revocation, and logout.
- Decide cookie domain, SameSite, Secure, CORS, and CSRF policy from the real deployment domains.
- Define resource ownership and authorization rules for channels, topics, posts, schedules, and publications.

### 3. Domain and state models

- Produce an ER diagram for all initial Prisma entities.
- Define identifiers, ownership, unique constraints, timestamps, and deletion policy.
- Define state machines for `Post`, `PostVersion`, `ModerationRequest`, `PostSchedule`, and `Publication`.
- Define legal transitions and the actor allowed to perform each transition.
- Define concurrency behavior for approval, revision, cancellation, and publication.
- Decide whether audit events require a dedicated persisted model.

### 4. Scheduling and delivery semantics

- Define supported one-time and recurring schedule expressions.
- Use IANA time zones and define daylight-saving behavior.
- Define editing, pausing, resuming, cancellation, and missed-run policy.
- Define retry limits, backoff, terminal failure, and manual retry behavior.
- Define uniqueness rules for each scheduled occurrence and Telegram publication.

### 5. AI, ephemeral image, and usage contracts

- Define provider-neutral text and image generation requests/results.
- Define the boundary between persisted final post data and non-persisted GPT conversation data.
- Define temporary local image handling, deletion, capacity, and retry rules without durable object storage.
- Define `AIRequest` accounting fields without coupling the domain to one provider.
- Define subscription plans, entitlement resolution, quota periods, and reset rules.
- Define atomic reserve, commit, and release semantics for costly operations.

## Deliverables

- [Architecture decision records](../../architecture/adr/) for identity, bot authentication, sessions, scheduling, queues, local PostgreSQL, and ephemeral AI content.
- [Initial OpenAPI contract](../../openapi/openapi.yaml).
- [ER diagram and domain model](../../architecture/domain-model.md) plus [Prisma model proposal](../../architecture/prisma-model-proposal.prisma).
- [Lifecycle/state-transition tables](../../architecture/lifecycles.md).
- [Environment-variable inventory](../../architecture/environment-variables.md) with secret/non-secret classification.
- [Integration notes](../../architecture/integration-contracts.md) for both client repositories.
- [Scenario walkthroughs](../../architecture/scenario-verification.md) for the approved MVP and failure paths.

## Verification

- Review the proposed operations against all MVP flows from both clients.
- Walk through immediate AUTO, MODERATION with revision, one-time schedule, and recurring schedule scenarios.
- Walk through duplicate requests, worker retry, API restart, Redis restart, and Telegram timeout scenarios.
- Confirm that no browser flow depends on Docker DNS or access to PostgreSQL/Redis.

## Exit criteria

- No unresolved decision blocks the Prisma schema, authentication implementation, or API bootstrap.
- The bot and Web Admin can implement against the API contract independently.
- Every domain mutation has an owner, authorization rule, and expected state transition.
- Durable state and ephemeral queue state are explicitly separated.

## Main risks

- Starting implementation before production domains are known may produce an invalid cookie/CORS design.
- Treating a Telegram user ID as bot authentication would leave internal endpoints forgeable.
- An incomplete state model may cause duplicate publication or conflicting moderation actions.
