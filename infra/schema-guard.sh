#!/usr/bin/env bash
#
# Destructive schema-change gate (#1182, part of epic #1179).
#
# WHY THIS EXISTS
#   This project syncs with `prisma db push --accept-data-loss` and has no
#   migrations/ folder, so there is no natural review point where a human sees
#   "this drops a column". A PR that renames a field reads as a rename in the
#   diff and lands as a DROP + ADD in production.
#
#   This script asks Prisma what SQL the pending push would actually run
#   (`migrate diff --script`, which PRINTS the SQL and writes no files), looks
#   for statements that destroy data, and stops the deploy when it finds any.
#
# USAGE
#   RUN_TOOL="docker run --rm -e DATABASE_URL=... $IMAGE" ./infra/schema-guard.sh [--warn-only]
#   ./infra/schema-guard.sh                      # uses npx directly
#
#   ENV VARS
#     DATABASE_URL       (required)
#     RUN_TOOL           command prefix used to run prisma (default: npx)
#     ALLOW_DESTRUCTIVE  set to 1 to proceed anyway — an operator decision
#     BACKUP_TAKEN       set to 1 by the caller when a fresh backup exists;
#                        ALLOW_DESTRUCTIVE is refused without it
#
# EXIT CODES
#   0 = safe (or warn-only, or explicitly allowed)   1 = destructive, stopping
set -euo pipefail

WARN_ONLY=0
[ "${1:-}" = "--warn-only" ] && WARN_ONLY=1

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\n\033[1;33m!!\033[0m %s\n' "$*"; }
err() { printf '\n\033[1;31mXX\033[0m %s\n' "$*" >&2; }

: "${DATABASE_URL:?DATABASE_URL is required}"
RUN_TOOL="${RUN_TOOL:-npx}"

log "Checking what the pending schema push would do"
# migrate diff only reads the live schema and the datamodel; it never writes a
# migration file, so the repo's "db push, no migrations/" rule is untouched.
if ! sql=$($RUN_TOOL prisma migrate diff \
      --from-url "$DATABASE_URL" \
      --to-schema-datamodel prisma/schema.prisma \
      --script 2>/dev/null); then
  # Never let an unavailable diff silently disable the gate: no answer means we
  # do not know, and "we do not know" must not read as "it is safe".
  err "Could not compute the schema diff — refusing to guess."
  err "Fix the connection or run with ALLOW_DESTRUCTIVE=1 BACKUP_TAKEN=1 if this is deliberate."
  [ "$WARN_ONLY" -eq 1 ] && { warn "warn-only: continuing"; exit 0; }
  [ "${ALLOW_DESTRUCTIVE:-0}" = "1" ] && [ "${BACKUP_TAKEN:-0}" = "1" ] && exit 0
  exit 1
fi

if [ -z "${sql//[[:space:]]/}" ]; then
  log "Schema already in sync — nothing to apply"
  exit 0
fi

# Statements that lose data. Kept as one grep -E alternation, deliberately
# blunt: a false alarm costs one env var, a miss costs the database.
#   DROP TABLE / DROP COLUMN     — the rename-looks-like-a-drop case
#   TRUNCATE                     — wipes rows outright
#   MODIFY/CHANGE ... NOT NULL   — fails or coerces existing NULL rows
#   DROP DATABASE / DROP SCHEMA  — the obvious catastrophe
DESTRUCTIVE='DROP TABLE|DROP COLUMN|TRUNCATE|DROP DATABASE|DROP SCHEMA|(MODIFY|CHANGE)[^;]*NOT NULL'

if ! hits=$(printf '%s\n' "$sql" | grep -Ei "$DESTRUCTIVE"); then
  log "Pending changes are additive — proceeding"
  exit 0
fi

warn "This deploy would run DESTRUCTIVE schema statements:"
printf '%s\n' "$hits" | sed 's/^/    /'

if [ "$WARN_ONLY" -eq 1 ]; then
  warn "warn-only mode (preview): continuing anyway"
  exit 0
fi

if [ "${ALLOW_DESTRUCTIVE:-0}" = "1" ]; then
  if [ "${BACKUP_TAKEN:-0}" != "1" ]; then
    err "ALLOW_DESTRUCTIVE=1 requires a fresh backup (BACKUP_TAKEN=1). Refusing."
    exit 1
  fi
  warn "ALLOW_DESTRUCTIVE=1 with a fresh backup — proceeding on operator's decision"
  exit 0
fi

err "Deploy stopped: the schema change above destroys data."
err "If it is intended, re-run with ALLOW_DESTRUCTIVE=1 (a backup must have been taken)."
err "If it is not, fix prisma/schema.prisma — a rename in the diff is a DROP + ADD here."
exit 1
