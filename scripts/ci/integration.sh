#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?Set DATABASE_URL to an isolated database ending in _test}"
node --input-type=module -e 'if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test")) throw new Error("Integration database name must end in _test")'
export AUTOBOT_TEST_DATABASE_URL="$DATABASE_URL"
npm run prisma:generate
npm run prisma:migrate:deploy
npm run generation-packs:provision
npm run generation-packs:provision
npm run test:integration
