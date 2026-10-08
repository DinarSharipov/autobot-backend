# ADR 0006: Local PostgreSQL and ephemeral AI content

- Status: Accepted; supersedes ADR 0005
- Date: 2026-10-08

## Context

Autobot should persist only user-owned settings and domain data. Raw GPT conversations and generated image binaries must not be stored in PostgreSQL. The deployment uses PostgreSQL on the backend server's local persistent disk and does not require S3/object storage.

## Decision

- PostgreSQL on a server-local Docker volume is the only durable application data store for MVP.
- Persist user settings and domain state required for product behavior: identity, channels, topics, post definitions, final post versions, moderation decisions, schedules, publication status/results, subscriptions, usage counters, audit events, and operational job state.
- `Post.prompt` and `Topic.promptTemplate` are user-authored product data. They are not AI conversation logs.
- Persist only the final generated text needed for moderation/publication as `PostVersion.text`.
- Do not persist provider request messages, system prompts assembled at runtime, multi-turn GPT conversation history, hidden reasoning, or raw provider responses.
- `AIRequest` stores only operational/accounting metadata: provider/model, operation kind, status, token/unit counts, cost, timestamps, and normalized error code.
- Do not store image bytes, base64, blobs, image URLs, filesystem paths, or `MediaAsset` records in PostgreSQL.
- Do not provision S3, MinIO, or another durable object store for MVP.
- Image generation happens after text approval and immediately before Telegram publication. MODERATION therefore approves text; pre-publication image review is out of scope for MVP.
- A generated image may exist only in a restricted temporary local directory during generation, validation, retry, and upload. It must be deleted after successful Telegram upload, terminal failure/cancellation, or TTL expiry.
- Temporary filenames are server-generated from non-secret operation IDs. They are never exposed as API URLs.
- PostgreSQL may store `publishedWithImage`, AI accounting, and Telegram message identifiers, but no image content or recoverable local path.
- If the process loses a temporary image before Telegram accepts it, an eligible retry regenerates the image under the same usage-operation key. Charging policy must prevent duplicate user quota consumption.

## Data classification

| Data                                         | Persist in PostgreSQL | Notes                                           |
| -------------------------------------------- | --------------------- | ----------------------------------------------- |
| User/profile/settings                        | yes                   | Product data                                    |
| Channels/topics/post configuration           | yes                   | Product data                                    |
| Final generated post text                    | yes                   | Required for moderation and publication history |
| GPT conversation/request-response transcript | no                    | Never written to DB/logs                        |
| AI token/cost/status metadata                | yes                   | No raw content                                  |
| Generated image bytes/base64                 | no                    | Temporary local file only                       |
| Image URL/local path                         | no                    | Not part of durable state                       |
| Telegram chat/message IDs                    | yes                   | Required publication result                     |

## Consequences

- Image moderation/preview before publication is not available in MVP.
- A retry may need to regenerate an image, but must not double consume the user's quota.
- Backups contain PostgreSQL domain data only and do not contain GPT conversations or generated images.
- Workers require a writable temporary directory with strict permissions, capacity limits, TTL cleanup, and startup reconciliation.
