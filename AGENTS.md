# Backend verification

- Before pushing code, run `npm run verify` and wait for its exit status. It uses disposable PostgreSQL/Redis, the same quality and integration scripts as GitHub Actions, and builds both deployment images.
- Install the repository pre-push hook once per checkout with `npm run hooks:install`.
- Never report a check as passed based on partial output or an unfinished command. After pushing, inspect the Actions run for that exact commit and wait for its final result.
- Domain/auth/health integration suites must disable background dispatchers and workers with `withoutBackgroundJobs`. The GPTunnel pipeline suite intentionally retains real BullMQ workers.
- Do not replace failed checks with unconditional retries or disable assertions to make CI green.
