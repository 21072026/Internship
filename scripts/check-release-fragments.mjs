// CI gate for release fragments (#1275): every releases/unreleased/*.json must
// parse, match the schema, and carry all three locales when it has user-facing
// notes. Run via `npm run check:release-fragments` (wired into ci.yml next to
// check:i18n). A malformed fragment must fail HERE, in the PR that adds it —
// not in next.config.js during the deploy build.
//
// It also prints the release timeline the fragments resolve to (#1457): one
// version per pending change, with the merge date and commit where the checkout
// has the history to see them. Reviewing a PR, that is the answer to "which
// version will this ship as?".
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveRelease } = require('./release-derive.cjs');
const pkg = require('../package.json');

try {
  const { timeline, version } = resolveRelease(process.cwd(), pkg.version);
  if (timeline.length === 0) {
    console.log(`release fragments OK — none pending (version stays ${pkg.version})`);
  } else {
    console.log(`release fragments OK — ${timeline.length} pending, ${pkg.version} -> ${version}`);
    for (const entry of timeline) {
      console.log(
        `  ${entry.version.padEnd(14)} ${entry.date || '(uncommitted)'} ${entry.time} ` +
          `${(entry.commit || '-').padEnd(7)}  ${entry.file}`
      );
    }
  }
} catch (error) {
  console.error(`XX ${error.message}`);
  process.exit(1);
}
