// Shared "is this DATABASE_URL safe for synthetic demo data?" predicate (#2063).
//
// WHY THIS IS ITS OWN MODULE
//   Two tools need the same answer: prisma/seed-demo.mjs (which WRITES demo
//   rows) and scripts/check-demo-fidelity.mjs (which COUNTS them). If those two
//   could disagree about what "local" means, the guard would be worthless — the
//   checker would happily connect to a database the seeder refuses, and the
//   next person would "fix" the mismatch by loosening the seeder. One module,
//   one definition.
//
// Allowed targets:
//   - a localhost/127.0.0.1 (or docker-compose `mysql`/`db` host) DATABASE_URL
//   - a database whose name ends in `_demo` — the public demo (#966) reaches
//     its dedicated DB over the container network, not localhost, so the host
//     check alone would reject it. Production is `internship_crm` and shared
//     preview is `internship_crm_preview`; neither can ever match.
//   - a per-PR topic database named `internship_pr<N>` (#1185) WITH
//     SEED_DEMO_FORCE=1. That database is created and dropped with the PR
//     environment and holds exactly this synthetic data. SEED_DEMO_FORCE used
//     to be a blanket bypass — "I know what I'm doing" is not a safety
//     property — and is now narrowed to that one unattended CI caller.

/** @param {string} url */
export function classifyDemoTarget(url = '') {
  const local = /@(localhost|127\.0\.0\.1|mysql|db)[:/]/.test(url);
  const demoDb = /\/[^/?]*_demo(\?|$)/.test(url);
  const topicDb = /\/internship_pr[0-9]+(\?|$)/.test(url);
  const forced = process.env.SEED_DEMO_FORCE === '1' && topicDb;
  return { local, demoDb, topicDb, forced, safe: local || demoDb || forced };
}

/** @param {string} url */
export function isSafeDemoTarget(url = '') {
  return classifyDemoTarget(url).safe;
}

/**
 * Exit the process unless DATABASE_URL points at a demo-safe database.
 * @param {string} tool - name used in the error message ("seed-demo", "check-demo-fidelity")
 */
export function assertSafeDemoTarget(tool) {
  const url = process.env.DATABASE_URL || '';
  const { safe, topicDb } = classifyDemoTarget(url);
  if (safe) return;
  console.error(
    `${tool}: DATABASE_URL does not look local. Refusing to touch demo data.\n` +
    'Allowed targets: a localhost DATABASE_URL, a database whose name ends in _demo,\n' +
    'or a per-PR topic database named internship_pr<N> with SEED_DEMO_FORCE=1.\n' +
    (process.env.SEED_DEMO_FORCE === '1' && !topicDb
      ? 'SEED_DEMO_FORCE=1 is set but the target is not an internship_pr<N> database — the flag no longer bypasses this check for anything else.'
      : '')
  );
  process.exit(1);
}
