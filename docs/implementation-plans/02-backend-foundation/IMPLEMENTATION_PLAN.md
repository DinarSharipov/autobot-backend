# Stage 2: Backend foundation

## Status

Completed on 2026-10-08. Runtime verification was performed against containerized PostgreSQL
and Redis as well as the production Docker image.

## Objective

Create a reproducible NestJS backend that starts locally and in Docker, validates its environment, connects to PostgreSQL and Redis, exposes health/OpenAPI endpoints, and provides the infrastructure required by later domain stages.

## Dependencies

- Approved Stage 1 technology and contract decisions.
- Selected Node.js and package-manager versions.
- Agreed environment-variable inventory.

## In scope

- NestJS application scaffold.
- Configuration, logging, error handling, validation, and OpenAPI.
- Prisma/PostgreSQL and Redis/BullMQ infrastructure.
- Local Docker topology.
- Baseline unit and integration test harnesses.

## Tasks

### 1. Repository and application scaffold

- Initialize the package manager and lockfile.
- Create the NestJS application with strict TypeScript configuration.
- Add linting, formatting, type-check, test, and production-build scripts.
- Establish module boundaries for configuration, database, queues, health, and future domain modules.
- Define naming and import conventions without introducing client-side or grammY dependencies.

### 2. Configuration

- Add typed runtime validation for every environment variable.
- Fail startup on missing or invalid required configuration.
- Keep local defaults limited to safe development values.
- Provide an `.env.example` containing names and explanations but no secrets.
- Define separate configuration namespaces for HTTP, database, Redis, authentication, Telegram, AI providers, and observability.

### 3. HTTP platform

- Configure the global API prefix and versioning selected in Stage 1.
- Add DTO validation and transformation.
- Add a stable API error envelope and global exception handling.
- Add request/correlation IDs and structured request logging.
- Generate OpenAPI from controllers and schemas.
- Configure graceful shutdown.

### 4. Persistence and queues

- Add Prisma schema/migration commands and a shared Prisma service.
- Configure PostgreSQL connection lifecycle and migration workflow.
- Add Redis connection management.
- Register BullMQ queues through centralized queue names and typed job payloads.
- Keep processors in modules that can later run outside the API process.
- Add test utilities for cleaning isolated test data without touching development data.

### 5. Health and diagnostics

- Add liveness that verifies the process is responsive.
- Add readiness that reports required dependency availability.
- Keep health responses free of secrets and internal connection strings.
- Expose build/version metadata suitable for deployment verification.

### 6. Docker development topology

- Create the `autobot-api`, `autobot-postgres`, and `autobot-redis` services.
- Create `autobot-shared` and private `backend-internal` networks as documented.
- Attach the API to both networks and data services only to the internal network.
- Add persistent database/Redis volumes and health checks.
- Keep the PostgreSQL volume on the server's local persistent disk.
- Add a restricted temporary image directory only when image generation is enabled; do not make it a durable application-data volume.
- Ensure PostgreSQL and Redis do not publish production ports.

## Deliverables

- Runnable NestJS project and committed lockfile.
- Validated configuration and `.env.example`.
- Initial Prisma setup and baseline migration.
- Redis/BullMQ infrastructure modules.
- OpenAPI, liveness, and readiness endpoints.
- Docker Compose development stack.
- Unit and integration test setup.

## Implemented result

- NestJS 12 application with strict TypeScript, versioned `/api/v1` routing, validation,
  structured JSON logging, request IDs, a stable error envelope, CORS allowlists, Swagger, and
  graceful shutdown hooks.
- Prisma 7 schema and initial migration for the approved domain model, using the PostgreSQL
  driver adapter and a guarded test-database cleanup helper.
- Redis lifecycle service, BullMQ root configuration, centralized queue names, and content-free
  typed job payload contracts.
- Local Docker topology with an external `autobot-shared` network, a production-internal data
  network, persistent local PostgreSQL/Redis volumes, and non-persistent image `tmpfs`.
- Liveness, dependency-aware readiness, build metadata, configuration tests, and integration
  tests against isolated PostgreSQL/Redis instances.

## Verification

- Install dependencies from a clean checkout using the lockfile.
- Run lint, type checking, unit tests, integration tests, and production build.
- Start the complete stack through Docker Compose.
- Verify readiness changes when PostgreSQL or Redis becomes unavailable.
- Verify clean shutdown closes HTTP, database, and queue connections.
- Confirm the API is reachable as `http://autobot-api:3000` on `autobot-shared`.

Verification completed on 2026-10-08:

- lockfile install/audit, formatting, lint, type checking, unit tests, integration tests, and
  production build pass;
- the initial migration applies to both `autobot` and `autobot_test`;
- the production image starts as a non-root user and reports PostgreSQL/Redis readiness;
- readiness returns `503` naming only the unavailable dependency when PostgreSQL or Redis is
  stopped, then returns `200` after recovery;
- a SIGTERM-driven container stop exits with code `0`;
- another container on `autobot-shared` resolves `http://autobot-api:3000` and receives liveness.

## Exit criteria

- The project is reproducible from a clean checkout.
- Invalid configuration prevents startup with a clear non-secret error.
- PostgreSQL and Redis connectivity is proven by integration tests, not only static configuration.
- The foundation exposes no placeholder domain behavior that clients could depend on.

## Main risks

- Embedding workers directly into bootstrap code would make the future worker split expensive.
- A permissive configuration fallback could silently run production with unsafe values.
- Publishing data-service ports in production would violate the network boundary.
