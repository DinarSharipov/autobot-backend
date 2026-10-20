# Prepaid text funding: reservation integrity

This slice fixes reservation settlement and included-revision concurrency. It does not enable
`PREPAID_GENERATION_ENABLED` or add the cost-confirmation/resume API. Existing routes and the
legacy subscription ledger contract remain unchanged. No schema migration is required.

## Invariants covered

- Settlement ledger entries retain the publication ID from the durable reservation for audit.
- Wallet reserve, commit and release use one stable operation base; WalletService itself appends
  action suffixes to ledger entries. Legacy UsageService still receives action-specific keys.
- At most three included revisions can be reserved or committed per publication in total.
  Availability is checked before UPDATE, and a version predicate plus serializable transactions
  prevents concurrent callers from claiming the last slot twice. Exhaustion returns
  `REVISION_ALLOWANCE_EXHAUSTED` instead of a database CHECK violation.
- Duplicate reserve/commit/release calls are idempotent. Released operation keys cannot be reused
  for new work; a new attempt requires a new operation key.
- Provider errors and persistence errors have different outcomes. Terminal provider errors release
  the reservation. Retryable provider errors retain it. If persisting an otherwise successful
  result fails, the transaction rolls back and the error reaches the queue; the same running
  attempt, provider idempotency key and reservation are reused on retry.

## Validation

`test/prepaid-funding.integration.spec.ts` runs against disposable PostgreSQL with background
workers disabled and a fake text provider. It covers TEXT/IMAGE settlement, concurrent duplicate
settlement, the last included revision, three committed revisions, release/reuse, allowance
ownership, repeated generation jobs, transient/terminal provider failure and persistence recovery.
No real payment, generation or Telegram delivery is performed.

Run the complete local CI gate with:

```sh
npm run verify
```

## Rollout and remaining work

Deploy with the existing workflow and keep prepaid writes disabled. No seed or migration is
needed for this slice. Before enabling prepaid writes, implement and validate per-publication
funding mode, reservation at worker claim, explicit paid revision confirmation and expiry,
BLOCKED_FUNDS/resume, image preview/replacement/selection, and delivery reuse. The current
materialization-time reservation behavior remains in place until that next slice.

If earlier experimental prepaid traffic produced reservations with `:reserve` in their operation
keys, stop those workers and reconcile them individually before updating or retrying. This change
does not automatically rewrite ledger history or settle unknown reservations. Historical legacy
usage keys are preserved. Rollback is a code rollback with prepaid writes still disabled; do not
roll back across active prepaid reservations without reconciliation.
