#!/usr/bin/env bash
set -euo pipefail
npm run prisma:generate
npm run format:check
npm run lint
npm run prisma:validate
npm run openapi:lint
npm run typecheck
npm test
npm run build
