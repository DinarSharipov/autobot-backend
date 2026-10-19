#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
task_id="autobot-verify-$$"
cleanup() {
  docker rm -fv "$task_id-postgres" "$task_id-redis" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker run -d --name "$task_id-postgres" --tmpfs /var/lib/postgresql/data -e POSTGRES_USER=autobot -e POSTGRES_PASSWORD=autobot -e POSTGRES_DB=autobot_test -p 127.0.0.1::5432 postgres:17-alpine >/dev/null
docker run -d --name "$task_id-redis" -p 127.0.0.1::6379 redis:8-alpine >/dev/null
for service in postgres redis; do
  ready=false
  for attempt in {1..30}; do
    if [[ "$(docker inspect --format '{{.State.Running}}' "$task_id-$service")" != true ]]; then
      docker logs "$task_id-$service" >&2
      exit 1
    fi
    if { [[ "$service" == postgres ]] && docker exec "$task_id-postgres" pg_isready -U autobot -d autobot_test >/dev/null; } ||
       { [[ "$service" == redis ]] && docker exec "$task_id-redis" redis-cli ping >/dev/null; }; then
      ready=true
      break
    fi
    sleep 1
  done
  [[ "$ready" == true ]] || { echo "Test $service did not become ready" >&2; exit 1; }
done
pg_port="$(docker port "$task_id-postgres" 5432/tcp)"
redis_port="$(docker port "$task_id-redis" 6379/tcp)"
export DATABASE_URL="postgresql://autobot:autobot@127.0.0.1:${pg_port##*:}/autobot_test"
export AUTOBOT_TEST_REDIS_URL="redis://127.0.0.1:${redis_port##*:}/15"
npm run ci:quality
npm run ci:integration
docker build --target runtime -t autobot-api:verify .
docker build --target migration -t autobot-migration:verify .
docker run --rm --network "container:$task_id-postgres" \
  -e DATABASE_URL=postgresql://autobot:autobot@127.0.0.1:5432/autobot_test \
  autobot-migration:verify
