# Migration policy

- Migrations are committed and applied forward-only with `prisma migrate deploy`.
- Every schema change must remain compatible with the currently deployed application during a
  rolling update; destructive column/table removal requires a later cleanup migration.
- Prisma does not generate down migrations. Rollback normally means redeploying the previous
  application image while retaining a backward-compatible schema.
- Before a production migration, verify the local PostgreSQL backup and restore procedure from
  Stage 6. If a non-compatible migration must be reverted, restore the database from that
  verified backup instead of improvising destructive SQL.
- The initial migration may be reset only in an explicitly disposable local/test database. The
  guarded test cleanup helper refuses database names that do not end in `_test`.
