// CI gate for release fragments (#1275): every releases/unreleased/*.json must
// parse, match the schema, and carry all three locales when it has user-facing
// notes. Run via `npm run check:release-fragments` (wired into ci.yml next to
// check:i18n). A malformed fragment must fail HERE, in the PR that adds it —
// not in next.config.js during the deploy build.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { readFragments, validateFragment, deriveVersion } = require('./release-derive.cjs');
const pkg = require('../package.json');

const fragments = readFragments(process.cwd());
try {
  fragments.forEach(validateFragment);
  const version = deriveVersion(pkg.version, fragments);
  console.log(
    fragments.length === 0
      ? `release fragments OK — none pending (version stays ${pkg.version})`
      : `release fragments OK — ${fragments.length} pending: ${fragments.map((f) => f.file).join(', ')} → ${version}`
  );
} catch (error) {
  console.error(`XX ${error.message}`);
  process.exit(1);
}
