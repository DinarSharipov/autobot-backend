# Stage 3: Identity and access

## Status

Completed on 2026-10-08. The production Telegram exchange/JWKS adapter is cryptographically
tested against a local OIDC server; a live Telegram smoke test remains a deployment check that
requires the real BotFather credentials and registered URLs.

## Objective

Implement one trusted user identity across the grammY bot and Web Admin, secure browser sessions, authenticated internal bot requests, and reusable authorization primitives for all later modules.

## Dependencies

- Stage 1 identity, API, domain, and deployment decisions.
- Stage 2 HTTP, Prisma, configuration, and test infrastructure.
- Telegram login credentials and bot-service credentials supplied through the environment.

## In scope

- Users and external Telegram identities.
- Browser login/session endpoints.
- Bot service authentication and user resolution.
- Cookie, CORS, CSRF, rate-limit, and ownership foundations.

## Tasks

### 1. Persistence models

- Implement `User`, `AuthIdentity`, `TelegramAccount`, and `Session` according to the approved model.
- Add unique constraints preventing duplicate Telegram identities.
- Store only a hash of opaque session secrets.
- Store session expiry, revocation, and last-use metadata required by policy.
- Add migrations and integration tests for identity creation races.

### 2. Telegram browser authentication

- Validate the Telegram login payload exclusively on the backend.
- Reject invalid signatures, expired payloads, and replay where the chosen protocol requires it.
- Resolve or transactionally create the matching identity and user.
- Create and rotate a secure browser session.
- Implement session inspection and logout endpoints.
- Return only the minimum user profile required by clients.

### 3. Browser security boundary

- Set HttpOnly and Secure cookies with the approved SameSite/domain/path policy.
- Configure credentialed CORS with an exact environment-driven origin allowlist.
- Reject unexpected origins and never combine credentials with wildcard origins.
- Implement the approved CSRF defense for state-changing cookie requests.
- Apply rate limits to authentication endpoints.

### 4. Bot-to-API authentication

- Implement the Stage 1 service-authentication scheme independently from end-user identity.
- Authenticate the bot service before accepting asserted Telegram user context.
- Resolve the asserted Telegram identity to the same application `User` used by browser login.
- Add replay protection and credential rotation support where required by the selected scheme.
- Log authentication failures without logging credentials or complete signed payloads.

### 5. Authorization primitives

- Define typed browser and bot principals.
- Add guards/decorators for authenticated access and service origin where useful.
- Add ownership helpers that domain services can call without moving business rules into controllers.
- Define explicit authorization errors in the common API error contract.

## Deliverables

- Identity/session Prisma migration.
- Authentication and users modules.
- Telegram browser login, session, and logout endpoints.
- Authenticated internal bot boundary.
- Production-ready CORS/cookie/CSRF configuration.
- OpenAPI and integration-test coverage for authentication flows.

## Implemented result

- Race-safe `User`/`TelegramAccount`/`AuthIdentity` resolution with explicit conflict rejection
  and a session-query index migration.
- Telegram Authorization Code + PKCE flow with Redis-backed one-time state, nonce validation,
  server-side token exchange, JOSE/JWKS signature verification, issuer/audience/expiry checks,
  return URL allowlisting, and endpoint rate limiting.
- Opaque browser sessions with hash-only PostgreSQL storage, absolute/sliding expiry, rotation,
  revocation, Secure/HttpOnly host-only cookies, and session-derived CSRF tokens.
- HMAC-SHA-256 bot authentication with raw-body hashing, deterministic query canonicalization,
  constant-time comparison, timestamp limits, Redis nonce replay protection, and active/previous
  key rotation.
- Browser, bot-service, and bot-user principals; reusable guards/decorators and an ownership
  assertion service for later domain modules.
- `GET /auth/session`, `GET /auth/csrf`, `POST /auth/logout`,
  `POST /internal/telegram-users/resolve`, and dual-boundary `GET /me` endpoints.

## Verification

- Prove bot and browser flows resolve the same Telegram identity to one `User`.
- Test invalid, expired, replayed, and concurrently submitted login data.
- Test session expiry, revocation, logout, and secret rotation behavior.
- Test allowed and disallowed browser origins with credentials.
- Test state-changing browser requests with missing/invalid CSRF proof.
- Test that an unauthenticated caller cannot assert an arbitrary Telegram user through bot endpoints.

Verification completed on 2026-10-08:

- the public cross-repository HMAC vector produces the accepted digest;
- a real signed JWT is validated through the production token/JWKS adapter, including nonce
  rejection;
- browser OIDC and signed bot requests resolve to the same PostgreSQL user;
- login state replay, concurrent state use, stale bot timestamps, nonce replay, invalid
  signatures, identity-link conflicts, and concurrent identity creation are rejected safely;
- session hash-only storage, expiry, rotation, logout, CSRF, key rotation, and exact credentialed
  CORS behavior are covered by integration tests against PostgreSQL and Redis;
- runtime OpenAPI exposes every Stage 3 route and the Docker image remains healthy without local
  credentials, returning a safe unavailable response for disabled login.

## Exit criteria

- Both clients can authenticate through their intended boundary.
- No browser bearer token is required or returned for localStorage persistence.
- Identity creation is race-safe and uniqueness is enforced by PostgreSQL.
- Later modules receive a stable authenticated principal and can enforce ownership consistently.

## Main risks

- Cross-site cookie behavior depends on the final production domain topology.
- Trusting user identifiers from an unauthenticated bot request would compromise every domain resource.
- Storing raw session tokens would turn a database leak into active session compromise.
