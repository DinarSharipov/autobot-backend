# ADR 0007: Private Telegram previews and reusable media references

- Status: Accepted for the prepaid implementation; production rollout disabled
- Date: 2026-10-20
- Supersedes the image timing/preview/retry sections of ADR 0006 for PREPAID publications
- Implements the approved GENERATION_PACKS_PLAN.md image workflow

Prepaid image generation runs in a separate durable queue after initial text generation. Upload a
private preview to the owner through the same Telegram bot used for delivery. PostgreSQL stores
only operation/accounting state, Telegram file_id/file_unique_id and chat/message identifiers,
source text version and explicit selection/approval binding. It stores no image bytes, base64,
provider URL, path, raw conversation or provider response. S3/MinIO remain excluded.

MODERATION approves selected media for the current text; AUTO selects its initial accepted media
without a client decision. Reuse that file_id for delivery and retry. Text revisions do not buy
replacement media; an old-source image can only be kept explicitly for the new text. Every new
accepted generation costs 1 IMAGE, independently of TEXT. Rejection does not refund success.

Provider retries retain one operation key and reservation. Unknown Telegram upload results require
reconciliation and cannot trigger an automatic duplicate upload or paid replacement. Lost Telegram
references fail closed without publishing text alone. Temporary files are removed after use, with
TTL/startup cleanup as backup. Telegram availability and bot identity now constrain reference reuse;
there is no backend image backup or authenticated Web preview in this slice.

Legacy publications retain ADR 0006 timing/accounting until separately migrated. See
../../PREPAID_MEDIA.md for API, state transitions, validation, migration and rollout.
