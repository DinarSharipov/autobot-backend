#!/usr/bin/env bash
set -Eeuo pipefail

deploy_root='/opt/autobot/backend'
api_repository='ghcr.io/dinarsharipov/autobot-backend'
migration_repository='ghcr.io/dinarsharipov/autobot-backend-migration'

cd "$deploy_root"
exec 9>backend-update.lock
flock --nonblock 9 || exit 0

docker pull "$api_repository:dev" >/dev/null
docker pull "$migration_repository:dev" >/dev/null

desired_sha="$(docker image inspect "$api_repository:dev" \
  --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')"
migration_sha="$(docker image inspect "$migration_repository:dev" \
  --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')"

if [[ ! "$desired_sha" =~ ^[0-9a-f]{40}$ || "$migration_sha" != "$desired_sha" ]]; then
  echo 'Published API and migration images do not have one valid revision' >&2
  exit 1
fi

current_sha="$(docker inspect autobot-api \
  --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' 2>/dev/null || true)"
current_health="$(docker inspect autobot-api \
  --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' 2>/dev/null || true)"

if [[ "$current_sha" == "$desired_sha" && "$current_health" == 'healthy' ]]; then
  exit 0
fi

awk \
  -v api_image="$api_repository:$desired_sha" \
  -v migration_image="$migration_repository:$desired_sha" \
  -v build_sha="$desired_sha" \
  'BEGIN { FS=OFS="=" }
   $1 == "AUTOBOT_API_IMAGE" { $2=api_image }
   $1 == "AUTOBOT_MIGRATION_IMAGE" { $2=migration_image }
   $1 == "BUILD_SHA" { $2=build_sha }
   { print }' .env > .env.next
chmod 600 .env.next

compose_next=(docker compose -p autobot-backend -f compose.yaml -f compose.prod.yaml --env-file .env.next)
"${compose_next[@]}" config --quiet

cp --preserve=mode,timestamps .env .env.previous
mv .env.next .env
chmod 600 .env

compose=(docker compose -p autobot-backend -f compose.yaml -f compose.prod.yaml --env-file .env)
"${compose[@]}" up -d --no-build autobot-postgres autobot-redis
"${compose[@]}" --profile deploy run --rm autobot-migrate
"${compose[@]}" up -d --no-build autobot-api

for _ in $(seq 1 40); do
  health="$(docker inspect autobot-api \
    --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' 2>/dev/null || true)"
  if [[ "$health" == 'healthy' ]]; then
    "${compose[@]}" up -d --no-build autobot-proxy
    exit 0
  fi
  if [[ "$health" == 'unhealthy' ]]; then
    "${compose[@]}" logs --tail 100 autobot-api >&2
    exit 1
  fi
  sleep 3
done

"${compose[@]}" logs --tail 100 autobot-api >&2
echo 'autobot-api did not become healthy in time' >&2
exit 1
