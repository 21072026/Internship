#!/usr/bin/env bash
#
# Database backup (#1181, part of the "don't sink us" epic #1179).
#
# WHY THIS EXISTS
#   Every merge to main deploys, and every deploy runs
#   `prisma db push --accept-data-loss` (infra/deploy-prod.sh). That flag means
#   exactly what it says: a renamed or removed column is DROPPED without asking.
#   Until this script existed there was no backup anywhere in the repo, so one
#   careless schema edit could destroy the product's only differentiator — the
#   accumulated interaction log, evaluations and stage history — with no way
#   back. The most valuable moment to hold a copy is therefore the instant
#   BEFORE the schema sync; a daily run covers everything else (a bad bulk
#   delete, a disk failure).
#
# WHAT IT DOES
#   mysqldump → gzip → $BACKUP_DIR/<env>-<stamp>.sql.gz, then sanity-checks the
#   size and prunes anything older than $KEEP_DAYS.
#
# USAGE
#   DATABASE_URL=mysql://user:pass@host:3306/db ./infra/backup-db.sh [--env prod] [--stamp 20260806T2312Z]
#
#   ENV VARS
#     DATABASE_URL  (required) same value the app uses
#     BACKUP_DIR    default /var/backups/internship-crm
#     KEEP_DAYS     default 7
#     MIN_BYTES     default 1024 — a smaller dump is treated as a failed one
#
# THE DUMPS CONTAIN REAL PERSONAL DATA (CVs, phone numbers, mentor notes).
# The directory is created 0700 and the files 0600. Never copy one into the
# repo, a preview environment, or a ticket.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/internship-crm}"
KEEP_DAYS="${KEEP_DAYS:-7}"
MIN_BYTES="${MIN_BYTES:-1024}"
ENV_NAME="prod"
# The caller passes its own timestamp so a deploy's backup carries the same
# stamp as its log lines; generated here only when run standalone (cron).
STAMP=""

while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_NAME="${2:?--env needs a value}"; shift 2 ;;
    --stamp) STAMP="${2:?--stamp needs a value}"; shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }

: "${DATABASE_URL:?DATABASE_URL is required}"
[ -n "$STAMP" ] || STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# Parse mysql://user:pass@host:port/db — the password may contain @ : / $ and
# spaces, so peel the URL apart from the OUTSIDE in (scheme, then the LAST @,
# which separates credentials from the host) rather than with one greedy regex.
url="${DATABASE_URL#mysql://}"
url="${url%%\?*}"                 # drop ?connection_limit=... etc
creds="${url%@*}"                 # everything before the last @
hostpart="${url##*@}"             # host:port/db
db_user="${creds%%:*}"
db_pass="${creds#*:}"
[ "$db_pass" = "$creds" ] && db_pass=""   # no colon → no password
db_name="${hostpart#*/}"
hostport="${hostpart%%/*}"
db_host="${hostport%%:*}"
db_port="${hostport#*:}"
[ "$db_port" = "$hostport" ] && db_port=3306

# URL-decoded password: a % escape in the connection string is not a literal.
decode() { printf '%b' "${1//%/\\x}"; }
db_pass="$(decode "$db_pass")"
db_user="$(decode "$db_user")"

command -v mysqldump >/dev/null || { echo "ERROR: mysqldump not found on PATH" >&2; exit 1; }

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
out="$BACKUP_DIR/${ENV_NAME}-${STAMP}.sql.gz"
tmp="$out.part"

log "Dumping $db_name from $db_host:$db_port → $out"
# --single-transaction: a consistent snapshot without locking the site.
# The password goes through the environment, never argv, so it cannot be read
# from the process list by another user on the box.
if ! MYSQL_PWD="$db_pass" mysqldump \
      --single-transaction --quick --routines --triggers --events \
      --no-tablespaces \
      -h "$db_host" -P "$db_port" -u "$db_user" "$db_name" 2>"$tmp.err" | gzip -c > "$tmp"; then
  echo "ERROR: mysqldump failed:" >&2
  tail -5 "$tmp.err" >&2 || true
  rm -f "$tmp" "$tmp.err"
  exit 1
fi
rm -f "$tmp.err"

# A zero-byte or truncated dump is worse than no dump: it looks like a backup
# and restores nothing. Three checks, cheapest first — size, then gzip
# integrity (catches a truncated stream), then content. The content check is
# the one that matters: size alone lies, because gzip squeezes a degenerate
# dump down to a few dozen bytes.
size=$(wc -c < "$tmp")
if [ "$size" -lt "$MIN_BYTES" ]; then
  echo "ERROR: dump is only ${size}B (< ${MIN_BYTES}B) — treating as failed" >&2
  rm -f "$tmp"
  exit 1
fi
if ! gzip -t "$tmp" 2>/dev/null; then
  echo "ERROR: dump is not a valid gzip stream (truncated?) — treating as failed" >&2
  rm -f "$tmp"
  exit 1
fi
# `grep -c`, not `grep -q`, and this is not a style choice (#1200). `grep -q`
# exits at the FIRST match, closing the pipe while `gzip` is still writing; gzip
# then dies of SIGPIPE (141) and `set -o pipefail` promotes that to the whole
# pipeline, so the check reported "no CREATE TABLE" for every dump big enough
# that gzip had not already finished — i.e. every real one. Prod's deploys had
# been failing here since the gate landed, while a small test DB passed because
# gzip got everything out before grep exited. `grep -c` consumes the whole
# stream, so there is no early close and no SIGPIPE. `|| true` because grep
# exits 1 on zero matches, which is a result here, not an error.
tables=$(gzip -dc "$tmp" | grep -ci 'CREATE TABLE' || true)
if [ "${tables:-0}" -eq 0 ]; then
  echo "ERROR: dump contains no CREATE TABLE — treating as failed" >&2
  rm -f "$tmp"
  exit 1
fi

mv "$tmp" "$out"
chmod 600 "$out"
log "Backup written: $out (${size} bytes, ${tables} tables)"

# Prune, but only our own files: the pattern is anchored to <env>-<stamp>.sql.gz
# so a stray file in the directory is never touched.
log "Pruning ${ENV_NAME} backups older than ${KEEP_DAYS} days"
find "$BACKUP_DIR" -maxdepth 1 -type f -name "${ENV_NAME}-*.sql.gz" -mtime "+${KEEP_DAYS}" -print -delete || true

# Leave the newest path where the caller (and the health check) can find it.
printf '%s\n' "$out" > "$BACKUP_DIR/.last-${ENV_NAME}"
