# ADR 0001: Canonical user and Telegram identity model

- Status: Accepted
- Date: 2026-10-08

## Context

The grammY bot identifies a person by Telegram's numeric user ID. Telegram browser login uses OIDC and supplies an OIDC subject plus Telegram profile claims. Both clients must resolve to one application user without making Telegram profile data the domain identity.

## Decision

- `User` is the internal aggregate root and uses an application UUID.
- `TelegramAccount` is the canonical Telegram account mapping. It stores the unique numeric Telegram user ID and mutable profile data.
- `AuthIdentity` represents a login credential. For Telegram OIDC it stores the unique `(provider = TELEGRAM, subject)` pair and links to the corresponding `User` and `TelegramAccount`.
- A grammY request resolves through `TelegramAccount.telegramUserId`.
- An OIDC login validates the token, reads both `sub` and the numeric Telegram `id` claim, and transactionally resolves both mappings.
- If `sub` and numeric Telegram ID already point to different users, authentication fails with `IDENTITY_LINK_CONFLICT`; accounts are never merged automatically.
- MVP ownership is single-user: channels, topics, posts, schedules, publications, subscriptions, and usage belong to one `User`. Teams and shared ownership are out of scope.
- Mutable Telegram fields such as username, display name, and avatar are profile metadata, not keys.
- User deletion is soft first. External publication/audit records retain stable internal user references according to retention policy.

## Consequences

- Bot and browser identity resolution converge without trusting browser-supplied profile data.
- Telegram numeric IDs are represented as decimal strings at the JSON boundary because JavaScript numbers cannot safely represent every 64-bit value.
- `AuthIdentity` and `TelegramAccount` have separate responsibilities and do not compete as the canonical domain identity.
