# ADR 0002: Telegram OIDC and server-side browser sessions

- Status: Accepted
- Date: 2026-10-08

## Context

Web Admin runs on another server and authenticates with Telegram. Authentication must not expose a reusable application bearer token to browser storage.

## Decision

- Use Telegram OpenID Connect Authorization Code Flow with PKCE (`S256`). The legacy iframe/hash login flow is not the implementation baseline.
- The backend owns `/api/v1/auth/telegram/start` and `/api/v1/auth/telegram/callback`.
- Login state, PKCE verifier, optional nonce, and validated return URL are stored in Redis for a short TTL. Loss of Redis may abort an in-progress login but cannot invalidate an established session.
- The callback exchanges the code server-side and validates the ID token signature through Telegram JWKS plus `iss`, `aud`, `exp`, `iat`, and `nonce` when supplied.
- Request only `openid profile` in MVP. Phone and bot-access scopes require a separate product decision.
- Establish a random opaque session secret with at least 256 bits of entropy. Store only its SHA-256 hash in PostgreSQL.
- Send the raw secret in a host-only `__Host-autobot_session` cookie with `HttpOnly`, `Secure`, and `Path=/`; do not set `Domain`.
- Default absolute session TTL is 30 days and idle TTL is 7 days. Both are configurable and enforced server-side.
- SameSite is environment-driven: use `Lax` when final domains are same-site; use `None` only for a genuinely cross-site Web Admin and only with `Secure` plus CSRF protection.
- `GET /api/v1/auth/csrf` issues a session-bound CSRF token. Browser mutations send it as `X-CSRF-Token`.
- Credentialed CORS uses an exact allowlist. Wildcard origin with credentials is forbidden.
- Login `returnTo` values are resolved only against a configured allowlist; arbitrary redirects are forbidden.
- Logout revokes the database session and clears the cookie. Session rotation occurs after login and security-sensitive changes.

## References

- [Telegram Login and OIDC](https://core.telegram.org/bots/telegram-login)
- [OIDC discovery](https://oauth.telegram.org/.well-known/openid-configuration)

## Consequences

- Web Admin never persists an application bearer token in `localStorage`.
- Production cookie behavior cannot be finalized until public origins are known, but implementation is unblocked through validated environment configuration.
- Web security tests must run in the real cross-origin topology before production release.
