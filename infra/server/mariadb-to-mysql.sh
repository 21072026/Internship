#!/usr/bin/env bash
#
# Restore a MariaDB production dump into the new MySQL 8 host (#2166).
#
# WHY THIS EXISTS
#   The obvious sequence — restore the dump, run `prisma db push` — DOES NOT WORK
#   when the source is MariaDB. It fails like this:
#
#     Error: You have an error in your SQL syntax ... near '{}' at line 1
#     type_change: Some(RiskyCast)
#
#   MariaDB has no native JSON type: `Json` columns are LONGTEXT. So `db push`
#   wants to `MODIFY ... JSON` all 20 of this schema's `Json` columns, and for the
#   ones carrying `@default("{}")` / `@default("[]")` it emits
#
#     MODIFY `scores` JSON NOT NULL DEFAULT {}
#
#   MySQL 8 does not allow a literal DEFAULT on a JSON column, so the whole push
#   aborts and the database is left half-converted. (Note this is the *opposite*
#   of the Prisma behaviour recorded in #1150: adding a Json column DROPS the
#   default; casting to Json EMITS it.)
#
#   The fix is to do the cast ourselves, from Prisma's own diff with the invalid
#   defaults stripped, and only then let `db push` confirm. Prisma applies those
#   defaults client-side, so nothing is lost by not having them in the DDL.
#
# WHAT IT DOES
#   1. restores <dump> into a scratch database
#   2. refuses to continue if any Json column holds '' or invalid JSON — that
#      would fail the cast row by row (`npm run db:check-json` is the same idea)
#   3. derives the conversion SQL with `prisma migrate diff`, strips the invalid
#      DEFAULTs, applies it
#   4. runs `prisma db push`, which must report "already in sync"
#   5. only then swaps the scratch database over the target name
#
#   Everything happens in the scratch database until the last step, so a failure
#   at any point leaves the live target untouched.
#
# WHY PRISMA RUNS IN A CONTAINER
#   The host deliberately has no Node (the app ships as an image). `node:20-slim`
#   is public, so this needs no registry credentials — but Prisma's schema engine
#   needs OpenSSL, which that image lacks, hence the apt line.
#
# USAGE
#   sudo ./mariadb-to-mysql.sh --dump /path/prod.sql.gz [--target internship]
#
#   Env:
#     SECRETS      default /opt/internship-crm/secrets/mysql.env
#     CONTAINER    default internship-mysql
#     SCHEMA       default /opt/internship-crm/prisma-work/schema.prisma
#     PRISMA_VER   default 5.16.1  (keep in step with package.json)
#     KEEP_SCRATCH set to 1 to leave the scratch database behind for inspection
#
# THE DUMP CONTAINS REAL PERSONAL DATA. Move it host-to-host, never through a
# laptop; see docs/DATA_ACCESS_POLICY.md and the header of infra/backup-db.sh.
set -euo pipefail

SECRETS="${SECRETS:-/opt/internship-crm/secrets/mysql.env}"
CONTAINER="${CONTAINER:-internship-mysql}"
SCHEMA="${SCHEMA:-/opt/internship-crm/prisma-work/schema.prisma}"
PRISMA_VER="${PRISMA_VER:-5.16.1}"
TARGET="internship"
DUMP=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dump)   DUMP="${2:?--dump needs a path}"; shift 2 ;;
    --target) TARGET="${2:?--target needs a name}"; shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[0;32m✓\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31mFAIL\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run me as root (the secrets file is 0600)"
[ -n "$DUMP" ] || die "--dump is required"
[ -f "$DUMP" ] || die "no such dump: $DUMP"
[ -f "$SCHEMA" ] || die "no schema at $SCHEMA (copy prisma/schema.prisma there)"
# The scratch name must live under the grant the bootstrap hands the app user
# (`internship\_%`), or step 5's push would fail on permissions, not on schema.
SCRATCH="${TARGET}_migrate"

# shellcheck disable=SC1090
set -a; . "$SECRETS"; set +a
: "${MYSQL_ROOT_PASSWORD:?missing from $SECRETS}"
: "${APP_DB_PASSWORD:?missing from $SECRETS}"

# No `-i`: `docker exec -i` would inherit this script's stdin and eat the rest of
# it whenever the script itself is piped in over ssh.
m()  { docker exec "$CONTAINER" mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$@" 2>/dev/null; }
mq() { m -N -B -e "$1" "${2:-}"; }

prisma() {
  docker run --rm --network host \
    -v "$(dirname "$SCHEMA")":/w -w /w \
    -e DATABASE_URL="$1" \
    node:20-slim bash -c "
      apt-get update -qq >/dev/null 2>&1
      apt-get install -y -qq --no-install-recommends openssl ca-certificates >/dev/null 2>&1
      npx -y prisma@${PRISMA_VER} ${*:2}
    " 2>&1 | grep -vE '^npm notice|prisma:warn|^$'
}

SCRATCH_URL="mysql://internship:${APP_DB_PASSWORD}@127.0.0.1:3306/${SCRATCH}"

log "1/5  restoring $(basename "$DUMP") into $SCRATCH"
mq "DROP DATABASE IF EXISTS \`$SCRATCH\`;
    CREATE DATABASE \`$SCRATCH\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
# Restore errors must NOT be swallowed. An earlier version sent this stderr to
# /dev/null to hide mysql's "using a password" notice, and a failing restore then
# aborted the script under `set -e` with no output at all — the operator saw the
# step header and nothing else.
RESTORE_ERR="$(mktemp)"
set +e
zcat -f "$DUMP" | docker exec -i "$CONTAINER" \
  mysql -uroot -p"$MYSQL_ROOT_PASSWORD" --default-character-set=utf8mb4 "$SCRATCH" 2>"$RESTORE_ERR"
RESTORE_RC=${PIPESTATUS[1]}
set -e
if [ "$RESTORE_RC" -ne 0 ]; then
  grep -v 'Using a password' "$RESTORE_ERR" | head -10 >&2
  rm -f "$RESTORE_ERR"
  die "restore failed (mysql exit $RESTORE_RC)"
fi
rm -f "$RESTORE_ERR"
TABLES="$(mq "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$SCRATCH';")"
[ "${TABLES:-0}" -gt 0 ] || die "restore produced no tables"
ok "$TABLES tables"

log "2/5  checking every Json column can survive the cast"
BAD=0
while IFS=$'\t' read -r tbl col; do
  [ -n "$tbl" ] || continue
  [ "$(mq "SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema='$SCRATCH' AND table_name='$tbl' AND column_name='$col';")" = "1" ] || continue
  n="$(mq "SELECT COALESCE(SUM(\`$col\` IS NOT NULL AND \`$col\`<>'' AND JSON_VALID(\`$col\`)=0)
                         + SUM(\`$col\` IS NOT NULL AND \`$col\`=''),0) FROM \`$tbl\`;" "$SCRATCH")"
  if [ "${n:-0}" != "0" ]; then
    echo "    ✗ ${tbl}.${col}: $n unparseable row(s)"
    BAD=$((BAD + n))
  fi
done < <(awk '/^model /{m=$2} /^[ \t]+[a-zA-Z_]+[ \t]+Json/{gsub(/^[ \t]+/,"");split($0,a,/[ \t]+/);print m"\t"a[1]}' "$SCHEMA")
[ "$BAD" -eq 0 ] || die "$BAD row(s) would fail the JSON cast — repair them first (npm run db:check-json)"
ok "all Json columns parse"

log "3/5  deriving and applying the conversion"
DIFF="$(mktemp)"; trap 'rm -f "$DIFF"' EXIT
prisma "$SCRATCH_URL" migrate diff --from-url "$SCRATCH_URL" \
  --to-schema-datamodel /w/"$(basename "$SCHEMA")" --script > "$DIFF"
grep -q 'ALTER TABLE' "$DIFF" || die "prisma produced no diff — is the schema readable?"
# A destructive statement here means the source schema is further from main than
# a pure engine change; that is a decision for a human, not for this script.
if grep -qiE 'DROP (COLUMN|TABLE)' "$DIFF"; then
  grep -iE 'DROP (COLUMN|TABLE)' "$DIFF" >&2
  die "diff contains destructive statements — review before running this"
fi
sed -i -E 's/ DEFAULT (\{\}|\[\])//g' "$DIFF"
docker exec -i "$CONTAINER" mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$SCRATCH" < "$DIFF" 2>/dev/null
ok "$(mq "SELECT COUNT(*) FROM information_schema.columns
          WHERE table_schema='$SCRATCH' AND DATA_TYPE='json';") columns are now native JSON"

log "4/5  prisma db push must be a no-op"
OUT="$(prisma "$SCRATCH_URL" db push --schema=/w/"$(basename "$SCHEMA")" --skip-generate --accept-data-loss || true)"
printf '%s\n' "$OUT" | sed 's/^/    /'
printf '%s' "$OUT" | grep -q 'already in sync' \
  || die "db push still wants to change the schema — do not swap this in"
ok "schema matches"

log "5/5  swapping $SCRATCH over $TARGET"
# RENAME TABLE needs the destination schema to exist even when it is empty.
mq "CREATE DATABASE IF NOT EXISTS \`$TARGET\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
if [ "$(mq "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$TARGET';")" != "0" ]; then
  BAK="${TARGET}_prev_$(date -u +%Y%m%d%H%M%S)"
  mq "CREATE DATABASE \`$BAK\`;"
  # RENAME TABLE is metadata-only, so this is fast and keeps the old rows around
  # under $BAK until someone drops them deliberately.
  while IFS= read -r t; do
    [ -n "$t" ] && mq "RENAME TABLE \`$TARGET\`.\`$t\` TO \`$BAK\`.\`$t\`;"
  done < <(mq "SELECT table_name FROM information_schema.tables WHERE table_schema='$TARGET';")
  ok "previous contents parked in $BAK"
fi
while IFS= read -r t; do
  [ -n "$t" ] && mq "RENAME TABLE \`$SCRATCH\`.\`$t\` TO \`$TARGET\`.\`$t\`;"
done < <(mq "SELECT table_name FROM information_schema.tables WHERE table_schema='$SCRATCH';")
[ "${KEEP_SCRATCH:-0}" = "1" ] || mq "DROP DATABASE IF EXISTS \`$SCRATCH\`;"
ok "$(mq "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$TARGET';") tables live in $TARGET"

printf '\n'
m -t -e 'SELECT (SELECT COUNT(*) FROM User) users, (SELECT COUNT(*) FROM MentorshipRelation) relations,
                (SELECT COUNT(*) FROM InteractionLog) interactions, (SELECT COUNT(*) FROM Company) companies;' "$TARGET"
