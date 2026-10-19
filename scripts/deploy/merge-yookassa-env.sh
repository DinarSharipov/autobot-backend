#!/usr/bin/env bash
set -Eeuo pipefail

deploy_root='/opt/autobot/backend'
current_environment="$deploy_root/.env"
incoming_environment="$deploy_root/.env.yookassa.next"
next_environment="$deploy_root/.env.next"

if [[ ! -s "$current_environment" || ! -s "$incoming_environment" ]]; then
  echo 'Existing backend environment or YooKassa environment fragment is missing' >&2
  exit 1
fi

awk -F= '$1 != "YOOKASSA_SHOP_ID" && $1 != "YOOKASSA_SECRET_KEY" { print }' \
  "$current_environment" > "$next_environment"
cat "$incoming_environment" >> "$next_environment"
chmod 600 "$next_environment"
rm -f "$incoming_environment"
