# ADR 0005: Private S3-compatible media storage

- Status: Superseded by ADR 0006
- Date: 2026-10-08

## Context

Image generation requires durable storage independent from AI-provider URLs and API container filesystems.

## Decision

- Store generated media in a private S3-compatible object store behind a `MediaStorage` adapter.
- Keep object storage provider details outside domain and application services.
- Persist a `MediaAsset` record containing owner, storage key, MIME type, byte size, checksum, dimensions, lifecycle status, and timestamps.
- Store stable object keys, never expiring provider URLs, in PostgreSQL.
- API download/preview access uses short-lived presigned URLs or an authenticated streaming endpoint.
- Object keys are server-generated and never derived directly from user filenames.
- Validate MIME type, size, image dimensions, and checksum before marking an asset ready.
- Unattached/failed assets are eligible for cleanup after seven days. Published assets remain while their publication is retained; deleted-account cleanup follows the product retention policy.
- Local development may use MinIO or another S3-compatible implementation; production provider remains environment-configured.

## Consequences

- AI providers can change without invalidating published media references.
- The backend needs object-storage credentials and lifecycle cleanup work.
- Public buckets and permanent public object URLs are outside the approved design.

## Supersession

This decision is retained for history only. It must not be implemented. ADR 0006 removes persistent image/object storage from the product architecture.
