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
# TWO MODES
#   restic  — object storage (Cloudflare R2). The real target: a different
#             company, not just a different machine, and ENCRYPTED at rest.
#             That last part is not optional here: these dumps carry CVs, phone
#             numbers and mentor notes, and handing them to a third party in the
#             clear is not a backup strategy, it is a disclosure.
#   rsync   — a second machine over ssh. How this started, when the only spare
#             machine was the old host (#2169). Kept because a target you can
#             read with `ls` is a good thing to have while you are still proving
#             the other one works.
#
# USAGE
#   sudo OFFSITE_MODE=restic ./backup-offsite.sh
#   sudo OFFSITE_MODE=rsync OFFSITE_TARGET='root@host:/' ./backup-offsite.sh
#
#   Env (both):
#     BACKUP_DIR         default /var/backups/internship-crm
#     OFFSITE_MODE       restic | rsync   (default restic)
#     OFFSITE_MIN_FILES  default 1 — fail if fewer dumps than this exist locally
#     OFFSITE_ENV        default /opt/internship-crm/secrets/offsite.env
#
#   Env (restic, read from $OFFSITE_ENV — never passed on the command line,
#   where `ps` would show them):
#     RESTIC_REPOSITORY  s3:https://<account>.r2.cloudflarestorage.com/<bucket>
#     RESTIC_PASSWORD    repository encryption key — SEE THE WARNING BELOW
#     AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY   R2 token credentials
#
#   Env (rsync):
#     OFFSITE_TARGET   rsync destination
#     OFFSITE_SSH_KEY  default /home/ubuntu/.ssh/offsite_ed25519
#
# ⚠ LOSING RESTIC_PASSWORD LOSES THE BACKUPS. There is no recovery path — that
#   is the point of encryption. It must exist somewhere that is neither this
#   server nor R2, or a single failure takes both the data and the way to read
#   it. backup-offsite-setup.yml stores it as a GitHub secret for exactly this.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/internship-crm}"
OFFSITE_SSH_KEY="${OFFSITE_SSH_KEY:-/home/ubuntu/.ssh/offsite_ed25519}"
OFFSITE_MIN_FILES="${OFFSITE_MIN_FILES:-1}"
OFFSITE_MODE="${OFFSITE_MODE:-restic}"
OFFSITE_ENV="${OFFSITE_ENV:-/opt/internship-crm/secrets/offsite.env}"

log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[0;32m✓\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31mFAIL\033[0m %s\n' "$*" >&2; exit 1; }

[ -d "$BACKUP_DIR" ] || die "no backup dir at $BACKUP_DIR"

COUNT="$(find "$BACKUP_DIR" -maxdepth 1 -name '*.sql.gz' -type f | wc -l)"
[ "$COUNT" -ge "$OFFSITE_MIN_FILES" ] \
  || die "only $COUNT dump(s) in $BACKUP_DIR, expected at least $OFFSITE_MIN_FILES — refusing to report success on an empty push"

# ─────────────────────────────────────────────────────────────── restic mode ──
if [ "$OFFSITE_MODE" = restic ]; then
  command -v restic >/dev/null || die "restic is not installed (bootstrap.sh --only tools)"
  [ -f "$OFFSITE_ENV" ] || die "no credentials at $OFFSITE_ENV (run backup-offsite-setup.yml)"
  # shellcheck disable=SC1090
  set -a; . "$OFFSITE_ENV"; set +a
  : "${RESTIC_REPOSITORY:?missing from $OFFSITE_ENV}"
  : "${RESTIC_PASSWORD:?missing from $OFFSITE_ENV}"
  : "${AWS_ACCESS_KEY_ID:?missing from $OFFSITE_ENV}"
  : "${AWS_SECRET_ACCESS_KEY:?missing from $OFFSITE_ENV}"

  log "backing up $COUNT dump(s) to the object store"
  restic backup --host internship-crm --tag dumps "$BACKUP_DIR" 2>&1 \
    | grep -Ev '^unchanged |^new |^modified ' | sed 's/^/    /'

  # Retention. Dailies for a fortnight cover "someone deleted a row on Tuesday";
  # the weeklies and monthlies cover "nobody noticed until the quarter closed",
  # which is the failure that actually loses data. --prune reclaims the space in
  # the same pass, so the repository does not grow without bound inside a 10 GB
  # free tier.
  log "applying retention"
  restic forget --host internship-crm --tag dumps \
    --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune 2>&1 \
    | grep -Ei 'remove|keep|snapshots' | tail -5 | sed 's/^/    /'

  # Verify by READING BACK, not by trusting the exit code above. `restic check`
  # validates repository structure; --read-data-subset actually downloads and
  # re-hashes part of the data, which is the only thing that distinguishes a
  # backup from a directory of files nobody has ever opened. 5% keeps it cheap
  # and, over a fortnight of runs, covers the repository.
  log "verifying"
  restic check --read-data-subset=5% 2>&1 | tail -3 | sed 's/^/    /'
  LATEST="$(restic snapshots --host internship-crm --latest 1 --json 2>/dev/null \
            | python3 -c "import sys,json;s=json.load(sys.stdin);print(s[0]['time'][:19] if s else '')" || true)"
  [ -n "$LATEST" ] || die "no snapshot found after backup — refusing to report success"
  ok "latest snapshot $LATEST"
  ok "repository: $(restic stats --mode raw-data --json 2>/dev/null | python3 -c "import sys,json;d=json.load(sys.stdin);print(f\"{d['total_size']/1048576:.1f} MB\")" 2>/dev/null || echo '?')"
  exit 0
fi

# ──────────────────────────────────────────────────────────────── rsync mode ──
: "${OFFSITE_TARGET:?OFFSITE_TARGET is required in rsync mode (e.g. root@host:/)}"
[ -f "$OFFSITE_SSH_KEY" ] || die "no ssh key at $OFFSITE_SSH_KEY"
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
