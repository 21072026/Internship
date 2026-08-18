#!/usr/bin/env bash
#
# Regression tests for infra/schema-guard.sh's destructive-statement pattern.
#
# WHY THIS EXISTS
#   The pattern decides whether production is allowed to deploy at all, and it
#   runs nowhere else: only on the server, against a live DB, mid-deploy. Both
#   ways it can be wrong are expensive and neither shows up in normal CI:
#
#     - too narrow -> a DROP COLUMN reaches prod unannounced;
#     - too broad  -> a purely additive change is refused and prod silently
#       falls behind. That is what happened: `(MODIFY|CHANGE)[^;]*NOT NULL` has
#       no trailing word boundary, so the enum value CHANGES_REQUESTED in
#       WeeklyReport's CREATE TABLE (#1218) matched "CHANGE", the rest of the
#       line satisfied `[^;]*NOT NULL`, and prod stopped deploying while
#       preview kept going because it runs --warn-only.
#
#   So the fixtures below are real `prisma migrate diff --script` shapes, and
#   both directions are asserted — every genuinely destructive statement must
#   still match.
#
# USAGE
#   bash infra/test/schema-guard.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD_SH="$SCRIPT_DIR/../schema-guard.sh"

pass=0; fail=0
ok()  { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }

# Read the pattern out of the guard itself rather than copying it, so this test
# cannot pass against a stale duplicate of the regex.
DESTRUCTIVE="$(sed -n "s/^DESTRUCTIVE='\(.*\)'$/\1/p" "$GUARD_SH")"
if [ -z "$DESTRUCTIVE" ]; then
  printf '\033[31mXX\033[0m could not read DESTRUCTIVE from %s\n' "$GUARD_SH" >&2
  exit 1
fi
printf '\nPattern under test: %s\n\n' "$DESTRUCTIVE"

matches() { printf '%s\n' "$1" | grep -Eqi "$DESTRUCTIVE"; }

expect_destructive() { # $1 = label, $2 = sql
  if matches "$2"; then ok "flags: $1"; else bad "MISSED (would reach prod): $1"; fi
}
expect_safe() { # $1 = label, $2 = sql
  if matches "$2"; then bad "false alarm (would block prod): $1"; else ok "allows: $1"; fi
}

echo "Destructive statements must be flagged:"
expect_destructive 'DROP TABLE'                 'DROP TABLE `Old`;'
expect_destructive 'DROP COLUMN'                'ALTER TABLE `User` DROP COLUMN `bio`;'
expect_destructive 'TRUNCATE'                   'TRUNCATE TABLE `Session`;'
expect_destructive 'DROP DATABASE'              'DROP DATABASE `internship_crm`;'
expect_destructive 'DROP SCHEMA'                'DROP SCHEMA `public`;'
expect_destructive 'MODIFY ... NOT NULL'        'ALTER TABLE `User` MODIFY `bio` VARCHAR(191) NOT NULL;'
expect_destructive 'CHANGE ... NOT NULL'        'ALTER TABLE `User` CHANGE `old` `new` VARCHAR(191) NOT NULL;'
expect_destructive 'lowercase modify'           'alter table `User` modify `bio` varchar(191) not null;'
expect_destructive 'MODIFY COLUMN ... NOT NULL' 'ALTER TABLE `User` MODIFY COLUMN `bio` TEXT NOT NULL;'

echo
echo "Additive statements must be allowed:"
# The exact line that blocked production after #1218 merged.
expect_safe 'enum value containing CHANGE' \
  "    \`status\` ENUM('DRAFT', 'SUBMITTED', 'APPROVED', 'CHANGES_REQUESTED') NOT NULL DEFAULT 'DRAFT',"
expect_safe 'new NOT NULL column on a new table' \
  '    `position` VARCHAR(191) NOT NULL,'
expect_safe 'CREATE TABLE'                  'CREATE TABLE `Offer` ('
expect_safe 'ADD COLUMN, nullable'          'ALTER TABLE `User` ADD COLUMN `acceptingMentees` BOOLEAN NULL;'
expect_safe 'CREATE INDEX'                  'CREATE UNIQUE INDEX `Offer_scopeKey_key` ON `Offer`(`scopeKey`);'
expect_safe 'DROP INDEX (an index is not data)' 'DROP INDEX `CompanyInterest_companyId_menteeId_idx` ON `CompanyInterest`;'
expect_safe 'a column merely named changeNote' \
  '    `changeNote` TEXT NOT NULL,'

echo
echo "Enum MODIFY statements still hit the pattern (refined afterwards, #1244):"
expect_destructive 'MODIFY ... ENUM(...) NOT NULL' \
  "ALTER TABLE \`Project\` MODIFY \`ownerType\` ENUM('ADMIN', 'MENTOR', 'MENTEE', 'COMPANY') NOT NULL;"

# ---------------------------------------------------------------------------
# Enum-widening refinement (#1244): source the guard's helpers (no DB needed)
# and check that the clause-level comparison only ever accepts a pure widening.
# ---------------------------------------------------------------------------
# shellcheck source=../schema-guard.sh
SCHEMA_GUARD_LIB=1 . "$GUARD_SH"

expect_widening() { # $1 = label, $2 = forward clause, $3 = reverse clause
  if is_enum_widening "$2" "$3"; then ok "widening: $1"; else bad "NOT recognized as widening (would block prod): $1"; fi
}
expect_not_widening() { # $1 = label, $2 = forward clause, $3 = reverse clause
  if is_enum_widening "$2" "$3"; then bad "accepted as widening (would reach prod): $1"; else ok "stays destructive: $1"; fi
}

FWD_CLAUSE="MODIFY \`ownerType\` ENUM('ADMIN', 'MENTOR', 'MENTEE', 'COMPANY') NOT NULL"
REV_CLAUSE="MODIFY \`ownerType\` ENUM('ADMIN','MENTOR','COMPANY') NOT NULL"

echo
echo "is_enum_widening must accept only pure widenings:"
expect_widening 'adds one value (the #1223 case; comma spacing differs by direction)' "$FWD_CLAUSE" "$REV_CLAUSE"
expect_widening 'adds a value, with DEFAULT kept' \
  "MODIFY \`s\` ENUM('A', 'B', 'C') NOT NULL DEFAULT 'A'" \
  "MODIFY \`s\` ENUM('A', 'B') NOT NULL DEFAULT 'A'"
expect_not_widening 'narrowing (reverse adds the value back)' "$REV_CLAUSE" "$FWD_CLAUSE"
expect_not_widening 'rename disguised as add (swaps a member)' \
  "MODIFY \`s\` ENUM('A', 'B', 'NEW') NOT NULL" \
  "MODIFY \`s\` ENUM('A', 'B', 'OLD') NOT NULL"
expect_not_widening 'same members (no real change)' "$FWD_CLAUSE" "$FWD_CLAUSE"
expect_not_widening 'NULL -> NOT NULL tightening alongside the add' \
  "MODIFY \`s\` ENUM('A', 'B', 'C') NOT NULL" \
  "MODIFY \`s\` ENUM('A', 'B') NULL"
expect_not_widening 'DEFAULT changes alongside the add' \
  "MODIFY \`s\` ENUM('A', 'B', 'C') NOT NULL DEFAULT 'C'" \
  "MODIFY \`s\` ENUM('A', 'B') NOT NULL DEFAULT 'A'"
expect_not_widening 'forward is not a MODIFY clause' \
  "DROP COLUMN \`s\`" \
  "$REV_CLAUSE"
expect_not_widening 'reverse is not an enum clause' \
  "$FWD_CLAUSE" \
  "MODIFY \`ownerType\` VARCHAR(191) NOT NULL"

echo
echo "normalize_sql canonicalizes both prisma diff dialects (#1244):"
# The reverse diff really does come out multi-line, lowercase, unspaced and
# with comment headers — this fixture is verbatim MariaDB reverse-diff output,
# including the Json-alias longtext noise bundled into the same ALTER.
REV_RAW='-- AlterTable
ALTER TABLE `Project` MODIFY `technologies` longtext NOT NULL,
    MODIFY `ownerType` enum('\''ADMIN'\'','\''MENTOR'\'','\''COMPANY'\'') NOT NULL;'
REV_NORM=$(printf '%s\n' "$REV_RAW" | normalize_sql)
if [ "$REV_NORM" = 'ALTER TABLE `Project` MODIFY `technologies` longtext NOT NULL, MODIFY `ownerType` ENUM('\''ADMIN'\'','\''MENTOR'\'','\''COMPANY'\'') NOT NULL;' ]; then
  ok "flattens the multi-line lowercase reverse dialect and strips comments"
else
  bad "normalize_sql output unexpected: $REV_NORM"
fi

echo
echo "alter_clauses splits bundled ALTERs at clause boundaries:"
CLAUSES=$(alter_clauses "$REV_NORM")
if [ "$(printf '%s\n' "$CLAUSES" | grep -c .)" = "2" ] \
   && printf '%s\n' "$CLAUSES" | grep -qxF "MODIFY \`ownerType\` ENUM('ADMIN','MENTOR','COMPANY') NOT NULL"; then
  ok "MariaDB longtext noise and the enum change come apart cleanly"
else
  bad "alter_clauses output unexpected: $CLAUSES"
fi

echo
echo "reverse_clause_for finds exactly one clause per table+column:"
if REV_FOUND=$(reverse_clause_for "$REV_NORM" "Project" "ownerType") \
   && [ "$REV_FOUND" = "MODIFY \`ownerType\` ENUM('ADMIN','MENTOR','COMPANY') NOT NULL" ]; then
  ok "finds the ownerType clause inside the bundled ALTER"
else
  bad "reverse_clause_for output unexpected: ${REV_FOUND:-<none>}"
fi
if reverse_clause_for "$REV_NORM" "Project" "missingCol" >/dev/null 2>&1; then
  bad "reverse_clause_for invented a clause for a missing column"
else
  ok "missing column stays destructive"
fi
AMBIG="$REV_NORM
ALTER TABLE \`Project\` MODIFY \`ownerType\` ENUM('X') NOT NULL;"
if reverse_clause_for "$AMBIG" "Project" "ownerType" >/dev/null 2>&1; then
  bad "reverse_clause_for accepted an ambiguous (duplicated) clause"
else
  ok "duplicated table+column stays destructive"
fi

echo
echo "end to end (no DB): the #1223 forward statement vs the MariaDB reverse:"
FWD_STMT="ALTER TABLE \`Project\` MODIFY \`ownerType\` ENUM('ADMIN', 'MENTOR', 'MENTEE', 'COMPANY') NOT NULL;"
FWD_ONLY_CLAUSE=$(alter_clauses "$FWD_STMT")
if REVC=$(reverse_clause_for "$REV_NORM" "Project" "ownerType") && is_enum_widening "$FWD_ONLY_CLAUSE" "$REVC"; then
  ok "the widening is recognized through the full helper pipeline"
else
  bad "helper pipeline failed to recognize the #1223 widening"
fi

echo
printf 'Total: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
