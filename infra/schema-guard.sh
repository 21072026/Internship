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

# --- enum-widening helpers (#1244) ------------------------------------------
# Adding a value to an enum emits
#   ALTER TABLE `T` MODIFY `col` ENUM('A','B','NEW') NOT NULL;
# which the blunt DESTRUCTIVE pattern flags although nothing is lost — while
# REMOVING a value emits the exact same statement shape, so the SQL text alone
# cannot tell the two apart. The reverse diff (schema -> live DB) can: for a
# pure widening, the reverse statement is the same MODIFY whose member list is
# a strict SUBSET of the forward one. Anything that fails to parse that way
# stays destructive — these helpers only ever downgrade a hit, never upgrade.

# Reprint SQL as one statement per line with single spaces and a canonical
# ENUM keyword. The two diff directions come out of prisma formatted
# differently (the reverse one splits ALTERs across lines, lowercases `enum`
# and drops the spaces after commas), so comparisons only make sense on this
# canonical form. POSIX awk on purpose — this must behave the same under GNU
# (server, CI) and BSD (macOS) userlands.
normalize_sql() { # stdin -> stdout
  # Comment lines (`-- AlterTable`, `-- CreateIndex`, ...) must go first, or
  # they get glued onto the front of the statement they precede when the
  # newlines collapse.
  awk '!/^[ \t]*--/' | awk 'BEGIN { RS=";" } {
    gsub(/[ \t\r\n]+/, " ");
    sub(/^ /, ""); sub(/ $/, "");
    gsub(/[Ee][Nn][Uu][Mm]\(/, "ENUM(");
    if (length($0)) print $0 ";";
  }'
}

# Split a normalized ALTER TABLE statement into its clauses, one per line
# (`MODIFY `col` ...`, `DROP COLUMN `x``, ...). Needed because MariaDB's Json
# alias makes the reverse diff bundle unrelated longtext MODIFYs into the SAME
# ALTER as the enum change — statements never compare equal there, clauses do.
# A comma+keyword sequence inside a quoted enum member would split wrongly and
# then fail the member comparison, which keeps things destructive (fail closed).
alter_clauses() { # $1 = normalized ALTER TABLE statement
  printf '%s\n' "$1" \
    | sed -e 's/^ALTER TABLE `[^`]*` //' -e 's/;$//' \
    | awk '{
        gsub(/, MODIFY /, "\nMODIFY ");
        gsub(/, CHANGE /, "\nCHANGE ");
        gsub(/, DROP /,   "\nDROP ");
        gsub(/, ADD /,    "\nADD ");
        gsub(/, ALTER /,  "\nALTER ");
        gsub(/, RENAME /, "\nRENAME ");
        print;
      }'
}

# Print one enum member per line from the first ENUM(...) in the clause.
# A member containing a quote, comma or ')' breaks this parse — and then the
# subset check below fails, which keeps the clause destructive (fail closed).
enum_members() { # $1 = normalized SQL clause
  printf '%s\n' "$1" | grep -oE "ENUM\([^)]*\)" | head -1 \
    | sed -e 's/^ENUM(//' -e 's/)$//' | tr ',' '\n' \
    | sed -e "s/^[[:space:]]*'//" -e "s/'[[:space:]]*$//"
}

# True iff the forward clause ($1) only ADDS enum values relative to the
# reverse clause ($2): identical clauses apart from the member list, exactly
# one ENUM(...) each, and the reverse members a strict subset of the forward
# ones. Both arguments must come out of alter_clauses on normalized SQL.
is_enum_widening() { # $1 = forward clause, $2 = reverse clause
  local shape_f shape_r fwd rev m
  case "$1" in 'MODIFY `'*'ENUM('*) ;; 'MODIFY COLUMN `'*'ENUM('*) ;; *) return 1 ;; esac
  [ "$(printf '%s' "$1" | awk -F 'ENUM\\(' '{ print NF - 1 }')" = "1" ] || return 1
  [ "$(printf '%s' "$2" | awk -F 'ENUM\\(' '{ print NF - 1 }')" = "1" ] || return 1
  shape_f=$(printf '%s' "$1" | sed 's/ENUM([^)]*)/ENUM(#)/')
  shape_r=$(printf '%s' "$2" | sed 's/ENUM([^)]*)/ENUM(#)/')
  [ "$shape_f" = "$shape_r" ] || return 1
  fwd=$(enum_members "$1")
  rev=$(enum_members "$2")
  [ -n "$fwd" ] && [ -n "$rev" ] || return 1
  while IFS= read -r m; do
    printf '%s\n' "$fwd" | grep -qxF "$m" || return 1
  done <<EOF
$rev
EOF
  [ "$(printf '%s\n' "$fwd" | wc -l)" -gt "$(printf '%s\n' "$rev" | wc -l)" ]
}

# Print the clause for `column` from the reverse diff's ALTERs on `table`,
# provided exactly ONE such clause exists (ambiguity stays destructive).
reverse_clause_for() { # $1 = reverse stmts (normalized), $2 = table, $3 = column
  local stmts clauses
  stmts=$(printf '%s\n' "$1" | grep -F "ALTER TABLE \`$2\` " || true)
  [ -n "$stmts" ] || return 1
  clauses=$(
    while IFS= read -r s; do alter_clauses "$s"; done <<EOF
$stmts
EOF
  )
  clauses=$(printf '%s\n' "$clauses" | grep -E "^(MODIFY|CHANGE) (COLUMN )?\`$3\` " || true)
  [ "$(printf '%s\n' "$clauses" | grep -c .)" = "1" ] || return 1
  printf '%s\n' "$clauses"
}

# Sourced by infra/test/schema-guard.test.sh to unit-test the helpers above
# without a database. Everything below this line needs DATABASE_URL.
if [ "${SCHEMA_GUARD_LIB:-0}" = "1" ]; then return 0 2>/dev/null || exit 0; fi

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
#
# MODIFY/CHANGE carry \b on both sides on purpose. Without the trailing one,
# any identifier that merely STARTS with "change" matches, and the rest of the
# line then satisfies `[^;]*NOT NULL` on its own — so a purely additive
# CREATE TABLE was rejected for containing an enum value named
# CHANGES_REQUESTED (WeeklyReport, #1218), blocking production deploys while
# preview sailed through on --warn-only. Blunt is fine; matching a substring of
# a column value is not.
DESTRUCTIVE='DROP TABLE|DROP COLUMN|TRUNCATE|DROP DATABASE|DROP SCHEMA|\b(MODIFY|CHANGE)\b[^;]*NOT NULL'

if ! hits=$(printf '%s\n' "$sql" | grep -Ei "$DESTRUCTIVE"); then
  log "Pending changes are additive — proceeding"
  exit 0
fi

# Second look for MODIFY ... ENUM(...) NOT NULL hits: widening an enum matches
# the pattern above but destroys nothing (#1223 was blocked by exactly this).
# Verify each candidate against the reverse diff and drop the pure widenings;
# every check that fails to line up keeps the hit destructive (fail closed).
if printf '%s\n' "$hits" | grep -Eqi 'MODIFY[^;]*ENUM\('; then
  log "ENUM change flagged — checking whether it only ADDS values"
  if rsql=$($RUN_TOOL prisma migrate diff \
        --from-schema-datamodel prisma/schema.prisma \
        --to-url "$DATABASE_URL" \
        --script 2>/dev/null); then
    fwd_stmts=$(printf '%s\n' "$sql" | normalize_sql)
    rev_stmts=$(printf '%s\n' "$rsql" | normalize_sql)
    # Collect the forward statements in which EVERY alarming clause is a
    # verified pure widening. Clause-by-clause, because either side may bundle
    # several column changes into one ALTER.
    accepted=""
    while IFS= read -r stmt; do
      case "$stmt" in
        'ALTER TABLE `'*) ;;
        *) continue ;;
      esac
      printf '%s\n' "$stmt" | grep -Eqi "$DESTRUCTIVE" || continue
      table=$(printf '%s' "$stmt" | sed -n 's/^ALTER TABLE `\([^`]*\)` .*/\1/p')
      [ -n "$table" ] || continue
      stmt_safe=1
      while IFS= read -r clause; do
        [ -z "$clause" ] && continue
        printf '%s\n' "$clause" | grep -Eqi "$DESTRUCTIVE" || continue
        col=$(printf '%s' "$clause" | sed -n 's/^MODIFY \(COLUMN \)\{0,1\}`\([^`]*\)` .*/\2/p')
        if [ -z "$col" ]; then stmt_safe=0; break; fi
        rev_clause=$(reverse_clause_for "$rev_stmts" "$table" "$col") || { stmt_safe=0; break; }
        if is_enum_widening "$clause" "$rev_clause"; then
          log "  enum widening (adds values, removes none): $table.$col"
        else
          stmt_safe=0; break
        fi
      done <<EOF2
$(alter_clauses "$stmt")
EOF2
      if [ "$stmt_safe" = "1" ]; then
        accepted="${accepted}${stmt}
"
      fi
    done <<EOF
$fwd_stmts
EOF
    # Drop every hit whose normalized text sits inside an accepted statement
    # (a hit can be a MODIFY fragment of a multi-line ALTER).
    if [ -n "$accepted" ]; then
      remaining=""
      while IFS= read -r line; do
        [ -z "$line" ] && continue
        line_n=$(printf '%s\n' "$line" | normalize_sql)
        case "$accepted" in
          *"$line_n"*) continue ;;
        esac
        remaining="${remaining}${line}
"
      done <<EOF
$hits
EOF
      hits="${remaining%
}"
      if [ -z "${hits//[[:space:]]/}" ]; then
        log "All flagged statements are pure enum widenings — proceeding"
        exit 0
      fi
    fi
  else
    warn "Could not compute the reverse diff — keeping the ENUM change flagged as destructive."
  fi
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
