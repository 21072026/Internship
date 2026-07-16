#!/usr/bin/env bash
#
# Optional push-to-deploy without GitHub Actions and without an inbound webhook
# (#636). Polls origin/main; when it moves, runs infra/deploy-prod.sh. No open
# port, no listener process, no security surface — just git + the deploy script.
#
# ONE-SHOT (for cron/systemd-timer — the recommended way):
#   */5 * * * *  cd /path/to/Internship && ENV_FILE=/etc/internship-crm/prod.env ./infra/autodeploy.sh
#
# LOOP (foreground / a systemd service):
#   INTERVAL=300 ./infra/autodeploy.sh --loop
#
# State (last deployed SHA) is kept in .git — the script simply compares the
# local main to origin/main, so it is safe to run concurrently-guarded by a
# lockfile.
#
set -euo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
BRANCH="${BRANCH:-main}"
INTERVAL="${INTERVAL:-300}"
LOCK="/tmp/internship-autodeploy.lock"

cd "$REPO_DIR"

deploy_if_changed() {
  git fetch origin "$BRANCH" --quiet
  local local_sha remote_sha
  local_sha="$(git rev-parse "$BRANCH" 2>/dev/null || echo none)"
  remote_sha="$(git rev-parse "origin/$BRANCH")"
  if [ "$local_sha" = "$remote_sha" ]; then
    return 0
  fi
  echo "$(date -u +%FT%TZ) main moved ${local_sha:0:7} → ${remote_sha:0:7}; deploying"
  # deploy-prod.sh does its own git reset --hard to origin/main.
  ./infra/deploy-prod.sh
}

# Prevent overlapping runs (cron every 5 min while a build takes longer).
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "another autodeploy run holds the lock; skipping"
  exit 0
fi

if [ "${1:-}" = "--loop" ]; then
  echo "autodeploy loop every ${INTERVAL}s (Ctrl-C to stop)"
  while true; do
    deploy_if_changed || echo "deploy attempt failed (will retry next tick)"
    sleep "$INTERVAL"
  done
else
  deploy_if_changed
fi
