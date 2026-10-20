# Prepaid text generation, paid revisions and resume

Status: implemented and integration-tested behind the disabled rollout.
`PREPAID_GENERATION_ENABLED=false` stays unchanged in deployment configuration.
No real generation, payment or Telegram request is needed for automated tests.
The backend owns prices, balances, reservations, confirmations and retry decisions.

## Funding lifecycle

Each publication records `fundingMode=LEGACY|PREPAID` at materialization. Existing rows default to
LEGACY. Changing the feature flag affects new occurrences only; it never changes settlement of
in-flight work. Drain existing prepaid work before treating the flag as a complete write shutdown.

Prepaid materialization does not reserve TEXT or IMAGE credits. Before calling the text provider,
the generation worker reserves one TEXT credit for initial text or an explicitly approved paid
revision. Successful text and its reservation commit in one transaction. A publication receives
three included successful text revisions after its initial text succeeds. Included revisions reserve
an allowance slot when accepted and commit it only after successful generation.

Terminal provider failure releases the hold. A failed revision restores the source text and its
moderation request with a new optimistic-lock version. A paid retry therefore needs a new quote;
a failed included revision restores its included slot. Failed initial text can be explicitly resumed
with a new reservation key. Retryable provider errors retain the same hold and provider idempotency
key; persistence errors roll back and reach the queue. Duplicate jobs or delivery retries do not
spend again. Invalid empty/oversized generated text is treated as terminal generation failure.

On insufficient TEXT credits or refund debt, generation becomes `status=PENDING`,
`fundingStatus=BLOCKED_FUNDS`, `errorCode=INSUFFICIENT_TEXT_CREDITS`. No provider attempt is created.
Published-outbox reconciliation skips this state. New events have a separate dispatch batch so
historical published events cannot starve resume; checked events move to the end of the recovery
scan without delaying recovery of a lost Redis job. Top-up does not silently resume work: the user
must request resume. Resume preserves the publication, schedule occurrence and approved paid
intent; it adds one outbox event transactionally. A second resume with the same idempotency key
returns the original result. Use a new key for a later explicit retry.

Cancellation of pending included/paid work releases any active hold. Text delivery remains
independent of text funding. Until image preview/selection is implemented, prepaid image delivery
fails closed with `MEDIA_UNAVAILABLE`, without generating an image or reserving IMAGE credits.
Do not enable prepaid for image posts in this slice.

## Bot API contract

Existing routes remain compatible. All requests require authenticated ownership. Mutations use
bot HMAC companion headers (ADR 0003), or browser session plus CSRF. Foreign publications return
404; unauthenticated requests return 401.

| Request                                                            | Result                                                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `POST /api/v1/publications/:publicationId/generation-cost-preview` | 200, one-use quote for current pending moderation; no credit reservation             |
| `POST /api/v1/moderation/:moderationRequestId/revision`            | Existing 202 route; optional `costConfirmationId` added, required for paid revisions |
| `POST /api/v1/publications/:publicationId/generation/resume`       | 202; requires `Idempotency-Key` (16–128 printable ASCII characters)                  |
| `GET /api/v1/publications/:publicationId`                          | Existing route; adds `fundingMode`, `fundingStatus`, `version`                       |

Preview is valid only during `AWAITING_MODERATION`. It issues a UUID bound to user, publication,
moderation request/version, allowance version and units. It expires after ten minutes and is
consumed in the same transaction as accepting the revision. Requesting an included revision
without a quote remains supported. An included quote cannot become a paid approval silently.
Once a paid revision is accepted, its durable approval survives a funds block and quote expiry;
resume does not request another charge approval for that same work.

A paid preview response (illustrative UUIDs):

```json
{
  "data": {
    "publicationId": "11111111-1111-4111-8111-111111111111",
    "moderationRequestId": "22222222-2222-4222-8222-222222222222",
    "moderationVersion": 1,
    "action": "PAID_REVISION",
    "creditType": "TEXT",
    "units": 1,
    "includedRemaining": 0,
    "available": 5,
    "debt": 0,
    "costConfirmationId": "33333333-3333-4333-8333-333333333333",
    "expiresAt": "2026-10-20T18:10:00.000Z"
  }
}
```

Send `If-Match: "1"`, a fresh `Idempotency-Key` and:

```json
{
  "feedback": "Make the opening shorter",
  "costConfirmationId": "33333333-3333-4333-8333-333333333333"
}
```

Revision/resume return the existing `{ "data": Publication }` envelope. Poll the publication:
a queued revision may subsequently become BLOCKED_FUNDS. Show a top-up action and then explicit
resume. Do not infer completion from the resume HTTP status.

Machine-readable errors:

- `COST_CONFIRMATION_REQUIRED`: included allowance exhausted, no paid approval supplied.
- `STALE_COST_CONFIRMATION`: quote expired, consumed, foreign or its binding/version/cost changed.
- `STALE_RESOURCE_VERSION`: supplied If-Match is stale; reload moderation before a new preview.
- `INSUFFICIENT_TEXT_CREDITS`: stored on blocked publications (includes debt).
- `GENERATION_NOT_RESUMABLE`: work is running, completed, cancelled or otherwise outside resume states.
- `PREPAID_NOT_APPLICABLE`: preview/resume requested for a legacy publication.
- `MEDIA_UNAVAILABLE`: prepaid image selection has not been rolled out.

The generated billing contract is version 1.2.0 in `docs/openapi/billing.openapi.json` (schemas
shared with runtime Swagger). `docs/openapi/openapi.yaml` references the new paths and documents
the existing moderation route and complete Publication response. Run
`npm run openapi:billing:generate` after changing shared schemas.

## Validation and deployment

```sh
npm run prisma:migrate:deploy
npm run generation-packs:provision
npm run verify
```

The new additive migration is `20261020150000_prepaid_text_confirmation`. It introduces funding
mode/intent fields on Publication and a GenerationCostConfirmation table with ownership/version
bindings. It neither backfills historical rows to prepaid nor changes balances or ledger history.
No additional secrets, provider configuration or seed packages are introduced. Deploy using the
existing CI/CD workflow; migration runs in the migration image before API startup.

The PostgreSQL integration suite uses fake providers and disables background workers. It covers
three successful included revisions, fourth paid confirmation and replay, stale/expired/foreign
quotes, free-to-paid protection, initial/paid funds blocks, debt, resume, concurrent last credit,
terminal failure/retry exhaustion, cancellation, schedules, ownership, legacy flag changes,
outbox reconciliation and delivery retry. The common `npm run verify` also runs quality,
acceptance, both deployment image builds and migration-container smoke checks.

Controlled rollout sequence:

1. Deploy schema and code with all checkout/prepaid flags still false; confirm normal legacy CI.
2. Complete image preview/replacement/selection/reuse and remaining media acceptance tests.
3. Resolve Telegram Stars versus external checkout policy and production payment-channel decision.
4. On an isolated test deployment, provision catalogue, use a test user and test payment, enable
   prepaid explicitly there, and run initial text → three included revisions → paid confirmation
   → blocked top-up/resume → publication. Verify ledger and provider reconciliation.
5. Define production allowlist/kill-switch and rollback criteria before enabling production writes.
   No global production enablement is part of this change.

Audit events record safe operation identifiers and credit type/units for blocked work,
accepted revisions and resume. They contain no provider secret, generated payload or feedback.

## Rollback

Prefer application rollback while retaining the additive schema, with new prepaid occurrences
disabled and workers stopped/drained. After any prepaid use, reconcile in-flight reservations and
accepted paid intents before rolling back to code that does not understand stored funding mode.
Never rewrite ledger history or delete funded work to permit rollback.

For an unused deployment only, `prisma/rollback/20261020150000_prepaid_text_confirmation.sql` guards
against any PREPAID publication before removing the new objects. Run with API/workers stopped,
a backup, and `psql --single-transaction -v ON_ERROR_STOP=1 -f <script>` against the intended DB.
A destructive schema rollback also needs an explicit Prisma migration-history/redeployment plan;
it is not the routine application rollback procedure. Integration tests execute this SQL inside a
transaction, verify refusal with prepaid data and verify schema restoration on transaction rollback.

Experimental reservations from pre-fix builds that used action-suffixed reservation keys require
manual reconciliation before reuse. This migration does not reinterpret those keys.
