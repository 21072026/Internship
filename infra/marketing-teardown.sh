#!/usr/bin/env bash
#
# Remove every trace of the Marketing CRM from the old Plesk box (#2348).
#
# WHY THIS EXISTS
#   Marketing CRM became a vertical of this repo; the `21072026/Marketing` repo
#   is deleted and its deployment on ersah.in has to go with it. The hard part
#   is not deleting things — it is deleting ONLY those things. Internship still
#   runs on the same box, sharing the MariaDB service, the `wildcard-ersah.in`
#   certificate and the Docker image store. The source repo's own teardown
#   script called `docker image prune -af`, which would have taken Internship's
#   images with it; this script deletes by name only, and refuses to touch
#   anything whose name says `internship`.
#
#   The full reasoning, including the inventory table and the mail trap that
#   cost us a 7-day fail2ban, is in docs/marketing-vertical/old-server-teardown.md.
#
# WHAT IT DOES
#   --inventory (default)  read-only: prints what is present, checks the mail
#                          trap, and reports the deploy key. Changes nothing.
#   --apply                steps 3-6 of the plan, in order, then re-verifies
#                          Internship. Requires TEARDOWN_CONFIRM=SOK-MARKETING.
#
# USAGE
#   bash infra/marketing-teardown.sh --inventory
#   TEARDOWN_CONFIRM=SOK-MARKETING bash infra/marketing-teardown.sh --apply
#
#   ENV VARS
#     TEARDOWN_CONFIRM  (required for --apply) must be exactly SOK-MARKETING
#     MAIL_CLEARED      set to 1 only after a human has cut a mail reference
#                       found by the mail check; otherwise --apply stops before
#                       removing the Plesk subdomains
#     BACKUP_DIR        default /var/backups
#
# NOT IN HERE, ON PURPOSE
#   Step 0 (deleting the repo / disabling Actions) and step 7 (pulling the
#   deploy key out of authorized_keys) are human decisions; this script only
#   reports on the second. See the plan's closing section.

set -euo pipefail

MODE=inventory
case "${1:-}" in
  --inventory | '') MODE=inventory ;;
  --apply) MODE=apply ;;
  *)
    echo "usage: $0 [--inventory|--apply]" >&2
    exit 2
    ;;
esac

BACKUP_DIR="${BACKUP_DIR:-/var/backups}"
DB_NAME=salevali_crm_test
DB_USER=salevali_test
# Overridable so infra/test/ can exercise step 6 without a real /etc path.
ENV_DIR="${ENV_DIR:-/etc/salevali-crm}"
ENV_FILE="${ENV_FILE:-${ENV_DIR}/test.env}"
IMAGE_REPO=ghcr.io/21072026/marketing
# Names we are allowed to destroy. Anything not matching is left alone, however
# suggestive it looks — the blast radius has to be a whitelist, not a hunch.
CONTAINER_RE='^salevali-crm-marketing(-pr[0-9]+)?$'
SUBDOMAIN_RE='^marketing(-pr[0-9]+)?$'

say() { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
die() {
  printf '\nXX %s\n' "$*" >&2
  exit 1
}

# The SSH user is root on this box, but a sudo-capable user must work too:
# mysql/mysqldump rely on root's ~/.my.cnf so the password never reaches `ps`.
if [ "$(id -u)" -eq 0 ]; then
  as_root() { "$@"; }
else
  as_root() { sudo -n "$@"; }
fi

have() { command -v "$1" >/dev/null 2>&1; }

# ── Read-only inventory ─────────────────────────────────────────────────────
# Printed in both modes: --apply starts by showing what it is about to act on,
# so the run log carries the before-state even when nobody watched it live.

say "0 · Box identity"
note "host: $(hostname -f 2>/dev/null || hostname)"
note "uptime:$(uptime -p 2>/dev/null || true)"

say "1 · Inventory (read-only)"
if have docker; then
  note "containers matching 'salevali':"
  as_root docker ps -a --filter 'name=salevali' \
    --format '   - {{.Names}}	{{.Image}}	{{.Status}}' || true
  note "images ${IMAGE_REPO}:"
  as_root docker images "$IMAGE_REPO" --format '   - {{.Repository}}:{{.Tag}}' || true
else
  note "docker not installed on this box"
fi

if have plesk; then
  note "Plesk subdomains matching 'marketing':"
  as_root plesk bin subdomain --list 2>/dev/null | grep -i marketing | sed 's/^/   - /' || note "   (none)"
else
  note "plesk CLI not present"
fi

if have mysql; then
  note "databases matching 'salevali':"
  as_root mysql -N -e "SELECT table_schema, COUNT(*) FROM information_schema.tables \
      WHERE table_schema LIKE 'salevali%' GROUP BY 1;" 2>/dev/null | sed 's/^/   - /' || true
fi

note "env dir ${ENV_DIR}:"
as_root ls -la "$ENV_DIR" 2>/dev/null | sed 's/^/   /' || note "   (absent)"

# ── The mail trap ───────────────────────────────────────────────────────────
# Removing a Plesk subdomain removes its mail domain with it. When crm.ersah.in
# went, reply@crm.ersah.in went too; the inbound reader kept connecting every
# 60s, dovecot logged auth_failed, fail2ban escalated to the `recidive` jail and
# banned every port for 7 days — outbound mail included. The error said only
# "Connection timeout". So: measure before deleting.

say "2 · Mail trap check"
MAIL_HITS=0
if have plesk; then
  if as_root plesk bin mail --info marketing.ersah.in >/dev/null 2>&1; then
    note "!! a mail domain EXISTS for marketing.ersah.in"
    MAIL_HITS=$((MAIL_HITS + 1))
  else
    note "no mail domain for marketing.ersah.in"
  fi
fi
# Captured, not piped into a test: a pipeline's status is the LAST command's,
# so `if grep ... | sed ...` is always true and would fake a hit every run.
MTA_HITS=$(as_root grep -ril 'marketing\.ersah\.in' /etc/postfix /etc/dovecot 2>/dev/null | head -5 || true)
if [ -n "$MTA_HITS" ]; then
  printf '   !! %s\n' $MTA_HITS
  MAIL_HITS=$((MAIL_HITS + 1))
fi
APP_HITS=$(as_root grep -ril 'marketing\.ersah\.in' /etc/internship-crm/ 2>/dev/null | head -5 || true)
if [ -n "$APP_HITS" ]; then
  printf '   !! Internship config references it: %s\n' $APP_HITS
  MAIL_HITS=$((MAIL_HITS + 1))
fi
[ "$MAIL_HITS" -eq 0 ] && note "clean — no mail domain, no references"

say "7 · Deploy key (report only — removing it is a human decision)"
KEYS="${HOME}/.ssh/authorized_keys"
if [ -f "$KEYS" ]; then
  # Comments only. Key material never goes into a CI log.
  awk '{print "   - line " NR ": " $NF}' "$KEYS" | grep -i 'marketing\|salevali' \
    || note "no authorized_keys entry names marketing/salevali"
else
  note "no ${KEYS}"
fi

if [ "$MODE" = inventory ]; then
  say "Inventory only — nothing was changed."
  exit 0
fi

# ── Destructive from here ───────────────────────────────────────────────────

[ "${TEARDOWN_CONFIRM:-}" = "SOK-MARKETING" ] ||
  die "refusing to act: set TEARDOWN_CONFIRM=SOK-MARKETING to run --apply"

if [ "$MAIL_HITS" -ne 0 ] && [ "${MAIL_CLEARED:-}" != "1" ]; then
  die "mail check found $MAIL_HITS reference(s). Cut the reference first (fix the env and RE-CREATE the container — docker restart does not re-read an env file), then re-run with MAIL_CLEARED=1."
fi

say "3 · Back up the database, then drop it"
if have mysql && as_root mysql -N -e "SHOW DATABASES LIKE '${DB_NAME}';" | grep -q "$DB_NAME"; then
  STAMP=$(date -u +%Y%m%dT%H%M%SZ)
  DUMP="${BACKUP_DIR}/${DB_NAME}-${STAMP}.sql.gz"
  as_root mkdir -p "$BACKUP_DIR"
  # The data is demo seed only (#2348), but a dump costs seconds and the
  # alternative is irreversible.
  # Written as a .part first and only renamed once it passes, so a truncated
  # dump can never look like a backup that exists.
  as_root mysqldump --single-transaction --routines "$DB_NAME" | gzip >"${DUMP}.part"

  # The same three checks infra/backup-db.sh makes, for the same reason: a
  # zero-byte dump is worse than no dump, because it looks like a backup and
  # restores nothing. Size alone lies (gzip squeezes a degenerate dump to a few
  # dozen bytes) and `gzip -t` passes on an EMPTY stream — a mysqldump that
  # produced nothing still yields a valid gzip member. Only the content check
  # catches that, and it uses `grep -c` rather than `grep -q` (#1200): -q exits
  # at the first match, gzip dies of SIGPIPE, and pipefail then fails every
  # dump big enough that gzip had not already finished.
  SIZE=$(wc -c <"${DUMP}.part")
  [ "$SIZE" -ge "${MIN_BYTES:-1024}" ] ||
    die "dump is only ${SIZE}B — treating as failed, nothing was dropped"
  gzip -t "${DUMP}.part" 2>/dev/null ||
    die "dump is not a valid gzip stream (truncated?) — nothing was dropped"
  TABLES=$(gzip -dc "${DUMP}.part" | grep -ci 'CREATE TABLE' || true)
  [ "${TABLES:-0}" -gt 0 ] ||
    die "dump contains no CREATE TABLE — treating as failed, nothing was dropped"
  as_root mv "${DUMP}.part" "$DUMP"
  note "dump verified: ${SIZE}B, ${TABLES} tables"
  note "dump OK -> ${DUMP}"

  # Only this database and these two users. The MariaDB service, the
  # internship_crm* databases and the crm* users are untouched.
  as_root mysql -e "DROP DATABASE IF EXISTS ${DB_NAME};
                    DROP USER IF EXISTS '${DB_USER}'@'localhost';
                    DROP USER IF EXISTS '${DB_USER}'@'172.17.%';
                    FLUSH PRIVILEGES;"
  note "dropped ${DB_NAME} and ${DB_USER}@{localhost,172.17.%}"
else
  note "${DB_NAME} not present — nothing to back up or drop"
fi

say "4 · Remove the containers and ONLY the Marketing images"
if have docker; then
  for c in $(as_root docker ps -a --filter 'name=salevali' --format '{{.Names}}'); do
    if [[ "$c" =~ $CONTAINER_RE ]]; then
      as_root docker stop "$c" >/dev/null 2>&1 || true
      as_root docker rm "$c" >/dev/null 2>&1 || true
      note "removed container ${c}"
    else
      note "left alone (name outside the whitelist): ${c}"
    fi
  done
  # By name. `docker image prune -a` would delete every unused image on the
  # box, Internship's included — that is the mistake this script exists to
  # avoid, so it is never called here.
  IMGS=$(as_root docker images "$IMAGE_REPO" -q | sort -u)
  if [ -n "$IMGS" ]; then
    # shellcheck disable=SC2086 # deliberately word-split: one id per argument
    as_root docker rmi $IMGS >/dev/null 2>&1 || true
    note "removed $(printf '%s\n' "$IMGS" | wc -l) image(s) of ${IMAGE_REPO}"
  else
    note "no ${IMAGE_REPO} images left"
  fi
fi

say "5 · Remove the Plesk subdomains"
if have plesk; then
  for s in $(as_root plesk bin subdomain --list 2>/dev/null | tr -d '\r' | awk '{print $1}'); do
    name="${s%%.*}"
    # The list prints either `marketing.ersah.in` or a bare `marketing`
    # depending on the Plesk version; accept both, reject anything else.
    if [[ "$name" =~ $SUBDOMAIN_RE ]] && { [ "$s" = "$name" ] || [[ "$s" == *.ersah.in ]]; }; then
      as_root plesk bin subdomain --remove "$name" -domain ersah.in && note "removed subdomain ${s}"
    fi
  done
  # The wildcard certificate stays. Internship's topic previews import the same
  # one (infra/server/topic-deploy.sh:442-443); removing it kills their TLS.
  note "certificate wildcard-ersah.in left in place (shared with Internship)"
fi

say "6 · Shred the env file"
if [ -f "$ENV_FILE" ]; then
  # It holds a generated NEXTAUTH_SECRET, HEALTH_TOKEN, CRON_SECRET and the DB
  # password; unlink alone leaves them on disk.
  as_root shred -u "$ENV_FILE" 2>/dev/null || as_root rm -f "$ENV_FILE"
  note "shredded ${ENV_FILE}"
fi
as_root rmdir "$ENV_DIR" 2>/dev/null || true

say "8 · Prove Internship is intact"
FAIL=0
if have docker; then
  OUT=$(as_root docker ps --filter 'name=internship-crm' --format '{{.Names}} {{.Status}}')
  [ -n "$OUT" ] || { note "!! no internship-crm container is running"; FAIL=1; }
  printf '%s\n' "$OUT" | sed 's/^/   - /'
fi
if curl -fsS --max-time 20 https://crm.ersah.in/api/health >/dev/null 2>&1; then
  note "crm.ersah.in/api/health OK"
else
  note "!! crm.ersah.in/api/health did not answer"
  FAIL=1
fi
if have mysql; then
  if as_root mysql -N -e "SHOW DATABASES;" | grep -q internship; then
    note "internship databases present"
  else
    note "!! no internship database found"
    FAIL=1
  fi
fi
if have plesk; then
  if as_root plesk bin certificate --info wildcard-ersah.in -domain ersah.in >/dev/null 2>&1; then
    note "certificate wildcard-ersah.in still installed"
  else
    note "!! wildcard-ersah.in certificate is missing"
    FAIL=1
  fi
fi

[ "$FAIL" -eq 0 ] || die "teardown ran but Internship's post-checks did not all pass — read the lines marked !! above"
say "Done. Marketing is off this box; Internship verified."
