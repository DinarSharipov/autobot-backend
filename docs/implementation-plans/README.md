# Detailed implementation plans

This directory contains the execution plans for the Autobot backend. The stages are ordered by dependency and should normally be completed sequentially.

## Stages

1. [Contracts and domain design](./01-contracts-and-domain/IMPLEMENTATION_PLAN.md)
2. [Backend foundation](./02-backend-foundation/IMPLEMENTATION_PLAN.md)
3. [Identity and access](./03-identity-and-access/IMPLEMENTATION_PLAN.md)
4. [Core domain and entitlements](./04-core-domain-and-entitlements/IMPLEMENTATION_PLAN.md)
5. [Publication pipeline](./05-publication-pipeline/IMPLEMENTATION_PLAN.md)
6. [Production readiness](./06-production-readiness/IMPLEMENTATION_PLAN.md)

## Scope boundary

These plans cover only `autobot-backend`:

- NestJS application and REST API;
- PostgreSQL/Prisma persistence;
- Redis/BullMQ queues;
- AI and Telegram adapters;
- backend Docker topology and deployment.

They define contracts consumed by `autobot` and `autobot-web`, but do not include implementation or deployment work in those repositories.

## Plan maintenance

- Record architecture decisions before implementing code that depends on them.
- Update the relevant stage plan when scope or an acceptance criterion changes.
- Track verified implementation progress in `../IMPLEMENTATION_STATUS.md`.
- Do not mark a task complete based only on scaffolding or static checks when runtime behavior is required.
