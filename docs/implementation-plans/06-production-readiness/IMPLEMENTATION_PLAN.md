# Stage 6: Production readiness

## Objective

Make the backend safely deployable, observable, recoverable, and verifiably compatible with independently deployed bot and Web Admin clients.

## Dependencies

- Completed functional stages and automated test suites.
- Configured GitHub Actions server connection secrets.
- Confirmed public API domain, TLS routing, data volumes, and operational ownership.

## In scope

- CI quality gates and Docker image production.
- Safe deployment and migration workflow.
- HTTPS/API exposure and private data networks.
- Monitoring, alerting, backup, restore, and runbooks.
- Security and failure-recovery validation.

## Tasks

### 1. Continuous integration

- Run deterministic dependency installation from the lockfile.
- Run lint, type checking, unit tests, integration tests, and production build on pull requests.
- Run Prisma formatting/validation and verify migration history.
- Generate/validate OpenAPI and detect unintended contract changes.
- Build the production Docker image and perform a container smoke test.
- Keep test secrets isolated from production environments.

### 2. Deployment pipeline

- Use the configured `SERVER_HOST`, `SERVER_PORT`, `SERVER_USER`, `SERVER_SSH_KEY`, and `SERVER_KNOWN_HOSTS` secrets without printing their values.
- Build and tag immutable backend images by commit.
- Deploy only backend services from this repository.
- Run backward-compatible database migrations as an explicit deployment step.
- Wait for readiness before completing deployment.
- Preserve PostgreSQL and Redis volumes.
- Do not restart the bot unless an explicitly coordinated incompatible API change requires it.
- Document rollback behavior for application images and database migrations.

### 3. Production network and HTTPS

- Attach `autobot-api` to `autobot-shared` and `backend-internal`.
- Keep PostgreSQL and Redis only on `backend-internal` with no public ports.
- Publish the API exclusively through the approved HTTPS reverse proxy/router.
- Restrict credentialed CORS to configured Web Admin origins.
- Apply request-size limits, timeouts, security headers, and rate limits.
- Verify the Web Admin uses the public URL and never local Docker DNS.

### 4. Runtime operations

- Emit structured logs with request, user-safe, post, publication, and job correlation identifiers.
- Add metrics for request errors/latency, queue depth/age, failed jobs, generation latency, publication success, and dependency availability.
- Configure alerts for sustained readiness failure, queue backlog, repeated publication failures, and resource exhaustion.
- Define retention for logs, job metadata, AI accounting metadata, and sessions; GPT conversations and images must not enter durable retention.
- Monitor temporary-image directory usage and cleanup age.
- Add safe tooling or documented procedures for retrying terminal jobs.

### 5. Data protection and recovery

- Configure automated PostgreSQL backups with retention and encryption appropriate to the environment.
- Verify backups contain no GPT conversation transcripts, image binaries, image URLs, or local image paths.
- Document Redis persistence expectations without treating Redis as the source of truth.
- Perform and record a restore drill into an isolated environment.
- Verify reconciliation recovers pending durable work after Redis loss.
- Document credential and Telegram/AI key rotation procedures.

### 6. Release validation

- Run end-to-end smoke tests for authentication, channel access, AUTO, MODERATION, scheduling, and history.
- Validate bot access through `http://autobot-api:3000` on the shared network.
- Validate Web Admin access through public HTTPS from its separate origin.
- Verify cookies, CORS, CSRF, authorization, and rate limits in the real topology.
- Run restart/recovery scenarios during queued and scheduled work.
- Confirm logs and API responses do not expose secrets or provider credentials.
- Confirm logs, database dumps, and backups do not contain provider conversations or generated images.

### 7. Documentation and runbooks

- Document deployment, rollback, migration, backup, restore, secret rotation, queue recovery, and incident triage.
- Document environment variables and ownership without including secret values.
- Record the first production deployment evidence and known limitations.
- Update `IMPLEMENTATION_STATUS.md` only from verified results.

## Deliverables

- GitHub Actions CI/CD workflows.
- Production Docker image and Compose/deployment configuration.
- HTTPS and network configuration documentation.
- Dashboards/alerts or their concrete configuration.
- Backup/restore evidence.
- Operational runbooks and release checklist.

## Verification

- Execute the complete CI pipeline from a clean commit.
- Deploy to the target environment and verify the exact image revision.
- Prove PostgreSQL and Redis are unreachable from the public network.
- Prove both client network paths independently.
- Restore a backup and reconcile pending work in an isolated environment.
- Roll back the application image while preserving compatible data.
- Run the MVP end-to-end acceptance suite against the deployed stack.

## Exit criteria

- Deployment is automated, repeatable, observable, and recoverable.
- Both clients pass contract and end-to-end smoke tests through their actual network paths.
- Production secrets remain outside source control and logs.
- Backup restoration and queue recovery are demonstrated, not only documented.
- Operators have actionable alerts and runbooks for common failure modes.

## Main risks

- Applying incompatible migrations before all clients are updated can break independently deployed consumers.
- A successful container start is not proof that migrations, queues, or external providers work.
- Backups without a tested restore procedure do not provide reliable recovery.
- Broad CORS or public data-service ports would undermine the intended server separation.
