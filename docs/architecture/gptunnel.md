# GPTunnel AI integration

The backend uses GPTunnel exclusively. Provider HTTP and response parsing are isolated behind
`GptunnelClient`, `GptunnelTextGenerationAdapter`, and `GptunnelImageGenerationAdapter`.
The REST post/moderation/scheduling contracts are unchanged; clients never talk to GPTunnel.

## Protocol sources

Reviewed on 2026-10-15:

- [Authentication and first request](https://docs.gptunnel.ru/)
- [Chat Completions](https://docs.gptunnel.ru/api/chat-completions/)
- [Chat models](https://docs.gptunnel.ru/api/models/)
- [Creative Lab model catalogue and parameter schemas](https://docs.gptunnel.ru/creative-lab/models/)
- [Media task creation and idempotency](https://docs.gptunnel.ru/creative-lab/create-task/)
- [Media task polling and result schema](https://docs.gptunnel.ru/creative-lab/get-task/)
- [Media error codes](https://docs.gptunnel.ru/creative-lab/errors/)

Requests send `Authorization: <GPTUNNEL_API_KEY>` without a Bearer prefix. URLs are fixed to
`https://gptunnel.ru`; there is no automatic fallback to another provider.

## Text and revisions

`POST /v1/chat/completions` receives a system instruction, user prompt and optional topic guidance.
A revision also receives the previous final version as an assistant message and the user's feedback.
These messages exist only during the call. Only final post text, request ID, normalized status/error,
and token accounting enter PostgreSQL. Reasoning and raw responses are discarded.

The response must contain non-empty `choices[0].message.content`. Truncation, moderation rejection
and Telegram-length violations fail the operation instead of publishing incomplete content.
The prompt and validation use 1024 UTF-16 code units for image captions or 4096 for text posts.

Network errors, timeouts, HTTP 408/429/5xx are retryable. Other HTTP failures are terminal, including
missing/invalid credentials, insufficient balance and forbidden models. Retry-After seconds are
preserved and combined with exponential queue backoff. Terminal failure releases reserved usage.
BullMQ retries and stalled-job recovery reuse the same running AI request and pending version;
only one successful version/usage commit is recorded. GPTunnel does not document an idempotency
contract for Chat Completions: a provider may bill a timed-out request even when our result was lost.
Application idempotency cannot guarantee a single provider charge in that case.

## Images

Image creation occurs inside the publication job after AUTO generation or moderation approval.

1. Read `GET /api/v2/media/models?type=IMAGE`. Require the configured model to be an IMAGE model
   without required input files. The provider validates configured model-specific parameters;
   an empty `GPTUNNEL_IMAGE_PARAMS` uses the provider's defaults.
2. Create `POST /api/v2/media/tasks` using `model`, `prompt`, `params`, `wait: false`, and the stable
   `idempotency_key=publication:<publicationId>:image`. Do not send OpenAI Images API fields.
3. Poll `GET /api/v2/media/tasks/:id` while status is `queued` or `running`, within one bounded deadline.
4. On `done`, download the first result over HTTPS without sending credentials. Redirects are rejected.
   Check the byte cap while streaming, then recognize PNG/JPEG/WebP by signature.
5. Write a restricted temporary file, upload it with Telegram sendPhoto, and remove it in `finally`.
   TTL cleanup handles files left by process termination. No image URL/path/bytes are stored in
   PostgreSQL or queue payloads.

Transport/poll/download retries reuse the same media idempotency key and task. Failed tasks are
terminal, including code 28: replaying that key returns the same failed task, so the backend does
not silently create and charge for replacement tasks. A new publication can explicitly request new
content. A task may remain running at GPTunnel after our local timeout; retrying resumes it by the
same key. Provider tasks/results have their own lifecycle outside local storage.

Media HTTP 429 code 6 means a key spending limit and is terminal. Codes 30 and 31 are transient;
code 30 supplies Retry-After. Task error messages/titles and HTTP error bodies are not copied into
user-visible errors, database metadata or logs; only normalized codes are retained.

## Configuration and validation

See [.env.example](../../.env.example) and [environment variables](./environment-variables.md).
Default model IDs must be checked against your authenticated catalogue before deployment. A missing
key fails closed without preventing bot-only health checks. No database migration is required.

Automated tests mock GPTunnel and Telegram HTTP; pipeline tests use real PostgreSQL and Redis/BullMQ.
For isolated native services on custom ports, set `AUTOBOT_TEST_DATABASE_URL` and
`AUTOBOT_TEST_REDIS_URL` when running integration tests, and apply migrations to that same test DB.
Database cleanup still refuses names that do not end in `_test`.
