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
printf 'Total: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
