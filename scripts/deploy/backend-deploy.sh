#!/usr/bin/env bash
set -Eeuo pipefail

deploy_root='/opt/autobot/backend'
compose=(docker compose -p autobot-backend -f compose.yaml -f compose.prod.yaml --env-file .env)

cd "$deploy_root"

if [[ ! -s .env.next ]]; then
  echo 'Staged production environment file is missing' >&2
  exit 1
fi

chmod 600 .env.next
docker compose -p autobot-backend -f compose.yaml -f compose.prod.yaml \
  --env-file .env.next config --quiet

if [[ -f .env ]]; then
  cp --preserve=mode,timestamps .env .env.previous
fi
mv .env.next .env
chmod 600 .env

docker network inspect autobot-shared >/dev/null 2>&1 || \
  docker network create --driver bridge --attachable autobot-shared >/dev/null

if [[ -z "${GHCR_USER:-}" ]]; then
  echo 'GHCR_USER is required' >&2
  exit 1
fi

IFS= read -r ghcr_token
if [[ -z "$ghcr_token" ]]; then
  echo 'GHCR token is required' >&2
  exit 1
fi

printf '%s' "$ghcr_token" | docker login ghcr.io --username "$GHCR_USER" --password-stdin >/dev/null
unset ghcr_token
trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT

"${compose[@]}" --profile deploy pull autobot-api autobot-migrate
"${compose[@]}" up -d --no-build autobot-postgres autobot-redis
"${compose[@]}" --profile deploy run --rm autobot-migrate
"${compose[@]}" up -d --no-build autobot-api

for _ in $(seq 1 60); do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' autobot-api 2>/dev/null || true)"
  if [[ "$health" == 'healthy' ]]; then
    for name in YOOKASSA_SHOP_ID YOOKASSA_SECRET_KEY; do
      if ! docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' autobot-api \
        | grep --quiet --extended-regexp "^${name}=.+$"; then
        echo "Required backend environment variable is absent: ${name}" >&2
        exit 1
      fi
    done
    echo 'Verified YooKassa credentials are present in autobot-api'
    "${compose[@]}" up -d --no-build autobot-proxy
    "${compose[@]}" ps
    exit 0
  fi
  sleep 5
done

"${compose[@]}" logs --tail 100 autobot-api >&2
echo 'autobot-api did not become healthy in time' >&2
exit 1
