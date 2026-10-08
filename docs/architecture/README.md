# Architecture contracts

This directory contains the Stage 1 architecture baseline for `autobot-backend`.

## Contents

- [`api-conventions.md`](./api-conventions.md) — shared REST conventions and compatibility policy.
- [`domain-model.md`](./domain-model.md) — domain boundaries, ownership, ER diagram, and persistence rules.
- [`prisma-model-proposal.prisma`](./prisma-model-proposal.prisma) — non-runtime Prisma schema proposal for Stage 2.
- [`lifecycles.md`](./lifecycles.md) — state machines and concurrency rules.
- [`scheduling-and-delivery.md`](./scheduling-and-delivery.md) — schedule, retry, and occurrence semantics.
- [`adr/0006-local-postgresql-and-ephemeral-ai-content.md`](./adr/0006-local-postgresql-and-ephemeral-ai-content.md) — current persistence and AI-content retention decision.
- [`environment-variables.md`](./environment-variables.md) — configuration contract and secret classification.
- [`integration-contracts.md`](./integration-contracts.md) — bot and Web Admin integration guidance.
- [`scenario-verification.md`](./scenario-verification.md) — walkthroughs used to validate the design.
- [`adr`](./adr/) — accepted architecture decisions.
- [`../openapi/openapi.yaml`](../openapi/openapi.yaml) — initial shared REST contract.

## Status

These documents define the implementation baseline. Values that depend on infrastructure not yet provisioned, such as public origins and hostnames, are environment-driven rather than hard-coded.

Changes to an accepted decision require a superseding ADR and compatible OpenAPI evolution.
