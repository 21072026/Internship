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
//
// BACKLOG WARNING (#2142). A pending fragment is normal — it is compacted
// within a day. A large, OLD backlog means release-compact.yml has stopped
// folding them, and while it is stuck CHANGELOG.md and src/lib/releaseNotes.ts
// stop recording what shipped. The alert email on that workflow covers the case
// where it RUNS AND FAILS; this covers the case where it stops running at all
// (disabled, schedule removed, or GitHub suspending cron after 60 days of repo
// inactivity) — then there is no failed run to alert on, and the only visible
// trace is the pile itself. Warn, never fail: an infrastructure problem must
// not block an unrelated PR. The workflow's own failure path now opens a
// labelled issue (#2323, scripts/release-compact-alert.mjs), so this warning
// is the second net, not the only one — and it names who acts, because as
// "not a problem with this PR" it was correctly read and correctly ignored.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveRelease } = require('./release-derive.cjs');
const pkg = require('../package.json');

/** Compaction runs daily, so a backlog this size or this old means it is stuck.
 *  Thresholds are deliberately loose — this is a smoke alarm, not a gate. */
const MAX_PENDING = 12;
const MAX_AGE_DAYS = 5;

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
    warnOnStaleBacklog(timeline);
  }
} catch (error) {
  console.error(`XX ${error.message}`);
  process.exit(1);
}

function warnOnStaleBacklog(timeline) {
  const dated = timeline.filter((entry) => entry.date);
  const oldest = dated.length ? dated[0].date : null;
  const ageDays = oldest
    ? Math.floor((Date.now() - Date.parse(`${oldest}T00:00:00Z`)) / 86_400_000)
    : 0;

  const reasons = [];
  if (timeline.length > MAX_PENDING) reasons.push(`${timeline.length} fragments are pending (> ${MAX_PENDING})`);
  if (ageDays > MAX_AGE_DAYS) reasons.push(`the oldest is from ${oldest}, ${ageDays} days ago (> ${MAX_AGE_DAYS})`);
  if (reasons.length === 0) return;

  // "Not a problem with this PR" was the whole message once, and it worked
  // exactly as written: every reviewer read it, agreed, and moved on for three
  // days while nothing recorded what shipped (#2323). A warning nobody is
  // accountable for is a warning nobody acts on — so it now says who acts and
  // where, and keeps saying it is not this PR's fault to fix in this PR.
  const message =
    `${reasons.join(' and ')}. Compaction runs daily, so this backlog means ` +
    'release-compact.yml is not folding fragments — CHANGELOG.md and ' +
    'src/lib/releaseNotes.ts have stopped recording what shipped. ' +
    'WHO ACTS: not this PR and not its reviewer — the maintainer (@mersahin), ' +
    'in #2323, by opening the pending PR from the bot/release-compact branch ' +
    'and choosing how Actions is allowed to open it in future. If #2323 is ' +
    'closed and this still fires, reopen it with a link to this run: something ' +
    'new is wrong. releases/README.md -> "When compaction is stuck" has the ' +
    'manual recovery, which any session can run.';

  // GitHub Actions annotation when running in CI, plain text otherwise.
  console.log(
    process.env.GITHUB_ACTIONS
      ? `::warning title=Release compaction looks stuck::${message}`
      : `!! release compaction looks stuck: ${message}`
  );
}
