// Ratchet: a real spreadsheet export can never be `git add`ed (#2409, #2555).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// WHY A TEST. The customer table the marketing import reads names real people
// with their addresses and phone numbers (docs/marketing-import.md → "The file
// is personal data"). What keeps it out of the repository is five lines of
// `.gitignore` — and a `.gitignore` edit that loosens them (a broader `!` for a
// new fixture folder, a pattern "tidied" to lower case only) fails nothing:
// the next `git add .` beside a downloaded export simply succeeds. The cutover
// (#2555) is exactly the moment such a file sits next to a checkout, so the
// rule is asserted by asking git itself, not by re-reading the patterns.
//
// `git check-ignore --no-index` answers for paths that do not exist and ignores
// what is already tracked, which is what the question is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function ignored(path) {
  try {
    execFileSync('git', ['check-ignore', '--no-index', '-q', path], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch (error) {
    // 1 = not ignored; anything else (no git, not a repository) is a broken test run.
    if (error && error.status === 1) return false;
    throw error;
  }
}

test('a spreadsheet export anywhere in the checkout is ignored, in any letter case', () => {
  for (const path of [
    'accounts.csv',
    'salevali-kunden.CSV',
    'Kunden.Xlsx',
    'export.xls',
    'export.ods',
    'export.tsv',
    'docs/marketing-accounts.csv',
    'import/accounts.csv',
    'scripts/accounts.csv',
    // A subfolder of the fixtures is NOT the exception.
    'scripts/fixtures/real/accounts.csv',
    // An upper-case extension in the fixtures folder is NOT the exception either.
    'scripts/fixtures/accounts.CSV',
  ]) {
    assert.equal(ignored(path), true, `${path} must be ignored`);
  }
});

test('the synthetic fixtures stay committable', () => {
  for (const path of ['scripts/fixtures/marketing-accounts-sample.csv', 'scripts/fixtures/other-sample.tsv']) {
    assert.equal(ignored(path), false, `${path} must stay trackable`);
  }
});
