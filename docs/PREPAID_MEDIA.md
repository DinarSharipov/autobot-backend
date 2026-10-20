# Prepaid media: preview, replacement, selection and reuse

Status: implemented behind the disabled prepaid rollout. No production flag is enabled by this
change. The backend owns wallet charging, provider execution, selection and delivery. The bot
renders returned state and invokes the API; it does not implement billing rules.

## Lifecycle

After successful initial prepaid TEXT generation, an occurrence configured with `generateImage`
gets exactly one durable PublicationMedia operation. Initial authorization is the server-owned
publication definition's `generateImage=true`. TEXT revisions do not create another image job.
The separate BullMQ `publication-media` queue reserves 1 IMAGE immediately before provider work.
No TEXT credit can fund an image. Zero IMAGE credits or IMAGE debt produces
`generationStatus=BLOCKED_FUNDS` with `INSUFFICIENT_IMAGE_CREDITS` before a provider call. The
occurrence stays intact; top-up requires explicit media resume with the same operation key.
If there is no selected image, Publication also exposes `fundingStatus=BLOCKED_FUNDS`.
A blocked replacement does not invalidate an existing selected image; reject the pending
replacement to continue with the existing selection.

A valid generated image is uploaded as a private preview to the owner's resolved Telegram user
chat. That user must have started this same bot. A preview never sends to the channel.
The backend stores Telegram `file_id`, `file_unique_id`, chat/message IDs, source and approved text
versions, safe provider task metadata, operation key and lifecycle state. Wallet COMMIT and the
accepted Telegram reference are saved atomically. No bytes, base64, provider URL, temporary path,
raw provider request/response or assembled prompt is stored in PostgreSQL.
Temporary files are removed after upload/failure/cancellation, with startup/TTL cleanup as backup.

MODERATION requires explicit image selection for the current text before approving the post.
AUTO moves from text generation to `AWAITING_MEDIA`, automatically selects its accepted initial
image and then becomes READY. Delivery and delivery retries use the selected Telegram file_id;
they never call image generation or debit again. This reuses a Telegram photo reference through
[sendPhoto](https://core.telegram.org/bots/api#sendphoto); `file_unique_id` is metadata and cannot
replace `file_id` for sending.

Every explicit replacement/new attempt requires a one-use 10-minute quote for 1 IMAGE, bound to
owner, publication version and current text version. Duplicate creation keys replay the same
operation. Only one active media generation is permitted per publication (database partial unique
index). A successful rejected preview remains charged. Failed/unusable generation releases its
hold; requesting a new attempt requires a new quote and operation key.

A text revision retains existing previews but marks their source outdated. It does not buy another
image. Selecting old-source media requires `keepOutdated=true`, bound through If-Match to the
current publication version; the selected media records the newly approved text version. While
an image is in flight, its source remains fixed; it may finish as an outdated preview after a text
revision. Stale callbacks cannot select for a newer text silently. Moderation approval and channel delivery
claim also advance the publication version, invalidating older preview callbacks and cost quotes.

## Failure and recovery

- Provider/download or known Telegram rate-limit failures retry under the same provider operation
  key and reservation, with bounded attempts/backoff. Provider task identifiers link IMAGE
  AIRequest accounting to the reservation; exact provider cost is not inferred from pack prices.
- The provider supports [task idempotency](https://docs.gptunnel.ru/creative-lab/create-task/).
  Do not change the image model/profile while media work is in flight; drain/reconcile first.
- Durable leases and a fencing token prevent a recovered generation worker and its stale predecessor
  from both uploading or settling. Expired RUNNING work can resume the same task.
- UPLOADING is persisted before Telegram upload. A timeout/ambiguous reply, or crash/lost database
  commit after upload, becomes `UPLOAD_UNKNOWN` on reconciliation. The backend releases an
  unaccepted hold, marks the artifact unavailable and never blindly uploads again. A stray private
  preview may exist without a usable backend reference; it cannot be selected. Investigate by media
  ID and provider task ID, without logging tokens or raw payloads. A new generation is explicit.
- Cancellation before upload cancels queued/running work and releases its hold. During UPLOADING,
  cancellation returns `MEDIA_GENERATION_IN_PROGRESS` until completion or lease reconciliation.
- A missing/rejected Telegram file reference becomes `MEDIA_UNAVAILABLE`. The accepted original
  generation remains charged. There is no automatic paid fallback or text-only publication. The
  owner may explicitly generate a replacement and select it to restore delivery.
- Scheduled occurrences and funding mode remain immutable across refill/retry. Legacy publication
  paths retain their existing accounting and image behavior.

## API for the bot

All routes are under `/api/v1/publications/:publicationId/media`. All reads require authenticated
ownership; mutations use HMAC companion headers or browser session + CSRF. Foreign resources
return 404. Refresh `GET media` or `GET publication` after a mutation to obtain the current
publication version for the next If-Match. Responses use `{ "data": ... }`.

| Method/path suffix      | Contract                                                                         |
| ----------------------- | -------------------------------------------------------------------------------- |
| `GET /`                 | Latest 100 previews, selectedMediaId and publicationVersion                      |
| `POST /cost-preview`    | Current text version, one-use confirmation, 1 IMAGE, available/debt, expiry      |
| `POST /`                | `{costConfirmationId}`; If-Match + Idempotency-Key; 202 durable QUEUED operation |
| `POST /:mediaId/select` | `{keepOutdated:false}`; If-Match + Idempotency-Key; explicit selection           |
| `POST /:mediaId/reject` | If-Match + Idempotency-Key; rejects ready media or cancels pre-upload work       |
| `POST /:mediaId/resume` | Idempotency-Key; only an approved BLOCKED_FUNDS operation; 202                   |

No client-supplied price, model, profile, wallet type, file reference, upload chat, path or provider
URL is accepted. Keys are 16–128 printable ASCII characters. Quote expiry does not invalidate an
already accepted operation blocked on funds. MODERATION mutations occur while awaiting review;
a queued replacement can pause READY delivery atomically. Delivery cannot start while AUTO is
awaiting media. An explicit replacement can recover a failed `MEDIA_UNAVAILABLE` publication.

Sample cost preview:

```json
{
  "data": {
    "publicationId": "11111111-1111-4111-8111-111111111111",
    "publicationVersion": 4,
    "textVersionId": "22222222-2222-4222-8222-222222222222",
    "creditType": "IMAGE",
    "units": 1,
    "available": 3,
    "debt": 0,
    "costConfirmationId": "33333333-3333-4333-8333-333333333333",
    "expiresAt": "2026-10-20T20:10:00.000Z"
  }
}
```

Submit that confirmation with `If-Match: "4"`. Poll GET media for `generationStatus=READY`, then
select its returned ID using the latest publication version. A ready media item includes:

```json
{
  "id": "44444444-4444-4444-8444-444444444444",
  "publicationId": "11111111-1111-4111-8111-111111111111",
  "status": "READY",
  "generationStatus": "READY",
  "sourceVersionId": "22222222-2222-4222-8222-222222222222",
  "approvedTextVersionId": null,
  "isOutdated": false,
  "selectionIsCurrent": false,
  "telegramFileId": "example-file-id",
  "telegramFileUniqueId": "example-unique-id",
  "telegramChatId": "1234567",
  "telegramMessageId": "99",
  "errorCode": null,
  "createdAt": "2026-10-20T20:01:00.000Z"
}
```

Machine-readable errors include `INSUFFICIENT_IMAGE_CREDITS`, `STALE_COST_CONFIRMATION`,
`STALE_RESOURCE_VERSION`, `MEDIA_GENERATION_IN_PROGRESS`, `MEDIA_OUTDATED`, `MEDIA_NOT_RESUMABLE`,
`MEDIA_NOT_MUTABLE`, `MEDIA_NOT_FOUND`, `MEDIA_UNAVAILABLE`, `MEDIA_UPLOAD_UNKNOWN` and
`PREPAID_MEDIA_NOT_APPLICABLE`. Body validation rejects a missing confirmation before creation.

The shared response schemas live in `src/publishing/publication-media.openapi.ts` and power runtime
Swagger and the generated billing OpenAPI 1.3.0. The main OpenAPI references all new paths and adds
AWAITING_MEDIA/selectedMediaId. Existing routes remain intact.

## Migration, checks and rollout

Migration: `20261020180000_prepaid_media`. It adds operation state, version bindings, leases,
confirmation records and AWAITING_MEDIA. Historical media references are marked READY if a file
reference exists, otherwise FAILED: migration never queues new paid work. No catalogue or secret
change is required. API and bot must use the same Telegram bot identity for file_id reuse.

```sh
npm run prisma:migrate:deploy
npm run generation-packs:provision
npm run openapi:billing:generate
npm run verify
```

The shared gate includes fake-provider PostgreSQL/Redis integration tests and HTTP adapter unit
checks, followed by acceptance, both Docker builds and migration-image smoke. Domain suites
explicitly disable the new dispatcher/worker; the media queue itself is tested against real Redis.
No real spending or Telegram messages occur in automated tests.

1. Deploy the additive migration/code using the existing CI/CD process with prepaid and checkout
   flags false. Check legacy behavior and image temp permissions/capacity.
2. Resolve production payment channel/Telegram Stars policy and production migration/allowlist
   decisions before enabling commercial prepaid writes.
3. In isolated test mode, use an owner who has started the bot, test credits and an explicit spend
   limit. Verify initial preview, replacement, stale text keep, rejection, selection, delivery retry,
   insufficient IMAGE funds/resume and lost-reference handling. Reconcile provider task IDs/ledger.
4. Rehearse worker crash recovery, backups/restore and migration from legacy in-flight work. Define
   rollout gates, allowlist and kill-switch before any global production enablement.

Normal rollback retains the additive schema with prepaid disabled and workers drained. Do not
restore old code across active media leases or accepted paid intents. The guarded
`prisma/rollback/20261020180000_prepaid_media.sql` refuses any PREPAID publication; use only on an
unused deployment, stopped workers, with backup and a Prisma migration-history plan. Execute
using `psql --single-transaction -v ON_ERROR_STOP=1 -f <script>`. The unused PostgreSQL enum value
AWAITING_MEDIA remains after rollback. Integration tests rehearse refusal and transactional rollback.
