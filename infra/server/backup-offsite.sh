#!/usr/bin/env bash
#
# Copy the local database dumps to a SECOND MACHINE (#2169).
#
# WHY THIS EXISTS
#   infra/backup-db.sh writes dumps to /var/backups/internship-crm — the same
#   disk as the database it just dumped. That is not a backup, it is a second
#   copy of the same failure domain, and 2026-09-03 proved it: when the old host
#   went unreachable the database AND every dump of it went with it. The only
#   reason no data was lost is that the box came back for 45 minutes.
#
# WHAT IT DOES
#   rsync every *.sql.gz to $OFFSITE_TARGET, then re-checks with --dry-run that
#   the remote side has nothing left to receive.
#
# WHY THE VERIFY PASS
#   The remote key is restricted to `rrsync -wo`, i.e. write-only: this host can
#   send files there and cannot read anything back, so "did it arrive" cannot be
#   answered by listing. A second rsync in --dry-run still exchanges the remote
#   file list to decide what to send, so "zero files pending" is a real
#   confirmation that the dumps are on the far side, obtained without granting
#   read access. Without this, a silently-truncated push looks identical to a
#   good one — which is exactly the class of failure this whole issue is about.
#
# NEVER --delete. The off-site copy must not be reachable-and-erasable from the
# machine being backed up; if this host is compromised or a script here goes
# wrong, the remote copies are what is left.
#
# TARGET
#   $OFFSITE_TARGET is an rsync destination. Today it is the old IONOS box, which
#   is a genuinely separate machine at a different provider — but it is also
#   scheduled for retirement and has been crashing (#2169). It is an INTERIM
#   target. Moving to object storage should be a change to this one variable
#   (plus the key), not a rewrite: keep the target abstract.
#
# USAGE
#   sudo OFFSITE_TARGET='root@s.ersah.in:/' ./backup-offsite.sh
#
#   Env:
#     BACKUP_DIR       default /var/backups/internship-crm
#     OFFSITE_TARGET   required — rsync destination
#     OFFSITE_SSH_KEY  default /home/ubuntu/.ssh/offsite_ed25519
#     OFFSITE_MIN_FILES  default 1 — fail if fewer dumps than this exist locally
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/internship-crm}"
OFFSITE_SSH_KEY="${OFFSITE_SSH_KEY:-/home/ubuntu/.ssh/offsite_ed25519}"
OFFSITE_MIN_FILES="${OFFSITE_MIN_FILES:-1}"
: "${OFFSITE_TARGET:?OFFSITE_TARGET is required (e.g. root@host:/)}"

log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[0;32m✓\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31mFAIL\033[0m %s\n' "$*" >&2; exit 1; }

[ -d "$BACKUP_DIR" ] || die "no backup dir at $BACKUP_DIR"
[ -f "$OFFSITE_SSH_KEY" ] || die "no ssh key at $OFFSITE_SSH_KEY"

COUNT="$(find "$BACKUP_DIR" -maxdepth 1 -name '*.sql.gz' -type f | wc -l)"
[ "$COUNT" -ge "$OFFSITE_MIN_FILES" ] \
  || die "only $COUNT dump(s) in $BACKUP_DIR, expected at least $OFFSITE_MIN_FILES — refusing to report success on an empty push"

RSH="ssh -i $OFFSITE_SSH_KEY -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20"

log "pushing $COUNT dump(s) to the off-site target"
# --ignore-existing: dumps are immutable once written, so anything already there
# is already correct. It also means a re-run cannot rewrite history remotely.
rsync -e "$RSH" -a --ignore-existing --stats \
  --include='*.sql.gz' --exclude='*' \
  "$BACKUP_DIR"/ "$OFFSITE_TARGET" \
  | grep -E 'Number of regular files transferred|Total transferred file size' \
  | sed 's/^/    /'

log "verifying the far side has everything"
# See the header: write-only means we cannot list, but a dry run still negotiates
# the remote file list, so a clean dry run is proof of arrival.
PENDING="$(rsync -e "$RSH" -a --ignore-existing --dry-run --out-format='%n' \
             --include='*.sql.gz' --exclude='*' \
             "$BACKUP_DIR"/ "$OFFSITE_TARGET" | grep -c '\.sql\.gz$' || true)"
[ "$PENDING" -eq 0 ] \
  || die "$PENDING dump(s) still missing on the off-site target after the push"
ok "all $COUNT dump(s) confirmed present off-site"
