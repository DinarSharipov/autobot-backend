#!/usr/bin/env bash
set -Eeuo pipefail

required=(
  SERVER_HOST
  SERVER_PORT
  SERVER_USER
  SERVER_KNOWN_HOSTS
  GHCR_USER
  GHCR_TOKEN
  PRODUCTION_ENV_FILE
)

missing=()
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    missing+=("$name")
  fi
done

if (( ${#missing[@]} > 0 )); then
  printf 'Missing deployment configuration: %s\n' "${missing[*]}" >&2
  exit 1
fi

if [[ -z "${SERVER_SSH_KEY:-}" && -z "${SERVER_PASSWORD:-}" ]]; then
  echo 'Either SERVER_SSH_KEY or SERVER_PASSWORD is required' >&2
  exit 1
fi

install -d -m 700 "$HOME/.ssh"
printf '%s\n' "$SERVER_KNOWN_HOSTS" > "$HOME/.ssh/known_hosts"
chmod 600 "$HOME/.ssh/known_hosts"

ssh_options=(
  -o BatchMode=yes
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile="$HOME/.ssh/known_hosts"
  -p "$SERVER_PORT"
)
scp_options=(
  -o BatchMode=yes
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile="$HOME/.ssh/known_hosts"
  -P "$SERVER_PORT"
)
ssh_prefix=()
scp_prefix=()

if [[ -n "${SERVER_SSH_KEY:-}" ]]; then
  key_file="$RUNNER_TEMP/autobot-deploy-key"
  printf '%s\n' "$SERVER_SSH_KEY" > "$key_file"
  chmod 600 "$key_file"
  ssh_options+=(-i "$key_file")
  scp_options+=(-i "$key_file")
else
  export SSHPASS="$SERVER_PASSWORD"
  ssh_options[1]='BatchMode=no'
  scp_options[1]='BatchMode=no'
  ssh_prefix=(sshpass -e)
  scp_prefix=(sshpass -e)
fi

remote="$SERVER_USER@$SERVER_HOST"
deploy_root='/opt/autobot/backend'

"${ssh_prefix[@]}" ssh "${ssh_options[@]}" "$remote" \
  "install -d -m 700 '$deploy_root'"

"${scp_prefix[@]}" scp "${scp_options[@]}" \
  compose.yaml \
  compose.prod.yaml \
  scripts/deploy/backend-deploy.sh \
  "$remote:$deploy_root/"

"${scp_prefix[@]}" scp "${scp_options[@]}" \
  "$PRODUCTION_ENV_FILE" \
  "$remote:$deploy_root/.env.next"

printf '%s' "$GHCR_TOKEN" | "${ssh_prefix[@]}" ssh "${ssh_options[@]}" "$remote" \
  "cd '$deploy_root' && GHCR_USER='$GHCR_USER' bash ./backend-deploy.sh"
