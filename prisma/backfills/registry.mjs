// The deploy's data migrations, in the order they run (#1540).
//
// Before this file they were twenty-odd `run_tool node prisma/… || true` lines
// hand-appended to infra/deploy-prod.sh: a failure was invisible, nothing
// recorded what had run where, and one of them (scripts/backfill-requisitions,
// #1385) "ran" on every deploy for months from an image that did not contain
// it — the `|| true` swallowed the MODULE_NOT_FOUND. Now there is one list,
// one runner (prisma/run-backfills.mjs) and a ledger (model BackfillRun).
//
// Each entry:
//   id        NNNN-kebab-slug — the ledger key; never renumber or reuse one.
//             The ARRAY order is the run order: an entry added later that must
//             run before an existing one takes the next free number and its
//             place in the list (0031 sits before 0011).
//   script    the file the runner executes with `node`, relative to the repo
//             root. It must exist IN THE IMAGE: prisma/ is copied whole, a
//             scripts/ file needs its own COPY line in the Dockerfile
//             (scripts/test/backfill-registry.test.mjs checks both).
//   args      extra arguments (`--apply` on the dry-run-by-default scripts)
//   once      true: skipped once the ledger holds a success for it — for the
//             genuinely one-shot grandfathers and baselines. false: runs on
//             every deploy, as before; these converge to a no-op.
//   optional  true: a failure is reported and the deploy goes on. Every entry
//             is optional today because every line was `|| true` before this
//             registry; the field makes that an explicit, per-entry decision a
//             reviewer can see and flip. `why` is required with it.
//   failNote  printed in addition when an optional entry fails
//
// THE ORDER IS LOAD-BEARING (CLAUDE.md, and the test pins these):
//   - activity/audit/task-template/AI-usage/telemetry org attribution BEFORE
//     backfill-organization, which fills every remaining NULL orgId with the
//     default org and would otherwise hand one tenant's rows to another;
//   - backfill-api-key-lifecycle AFTER backfill-organization (it needs the
//     default org to exist);
//   - backfill-skill-lists BEFORE backfill-skill-taxonomy (map the split lists),
//     and backfill-skill-levels AFTER it (it fills the rows taxonomy creates).
//
// The schema-bracketing steps are not here: the ones before the push
// (backfill-company-interest-scope, backfill-setting-id, the expand pushes and
// the pre-push backfill-json-columns --repair) are prisma/pre-push/registry.mjs
// (#3144), and the post-push --repair stays in infra/deploy-prod.sh right after
// the push. They make the push itself succeed; they are not data migrations
// that follow it.
//
// Plain ESM, no imports: the runner and the unit test both read it, and the
// server's Node 20 runs it without a TypeScript step.

const ALWAYS_OPTIONAL = 'Was `|| true` before #1540; kept non-blocking until it is deliberately made required.';

export const BACKFILLS = [
  // Seeds — only ever add missing rows.
  { id: '0001-seed-templates', script: 'prisma/seed-templates.mjs', once: false, optional: true, why: ALWAYS_OPTIONAL },
  // The shared project-goal template pool (#51) — only ever adds missing titles.
  { id: '0002-seed-goal-templates', script: 'prisma/seed-goal-templates.mjs', once: false, optional: true, why: ALWAYS_OPTIONAL },
  // The guided-conversation library (#1841) — missing titles and items only.
  { id: '0003-seed-agenda-templates', script: 'prisma/seed-agenda-templates.mjs', once: false, optional: true, why: ALWAYS_OPTIONAL },
  // Contributor terms v1.0 (#1025) — versioned rows; never edits an existing one.
  { id: '0004-seed-contributor-terms', script: 'prisma/seed-contributor-terms.mjs', once: false, optional: true, why: ALWAYS_OPTIONAL },
  { id: '0005-project-members', script: 'prisma/backfill-project-members.mjs', once: false, optional: true, why: ALWAYS_OPTIONAL },

  // Tenant attribution FIRST (cross-world isolation), then the default-org fill.
  { id: '0006-activity-log-org', script: 'prisma/backfill-activity-log-org.mjs', once: false, optional: true, why: ALWAYS_OPTIONAL },
  // The audit trail (#2012): the actor's org, then the target user's.
  { id: '0007-audit-log-org', script: 'prisma/backfill-audit-log-org.mjs', once: false, optional: true, why: ALWAYS_OPTIONAL },
  { id: '0008-task-template-org', script: 'prisma/backfill-task-template-org.mjs', once: false, optional: true, why: ALWAYS_OPTIONAL },
  { id: '0009-ai-usage-org', script: 'prisma/backfill-ai-usage-org.mjs', once: false, optional: true, why: ALWAYS_OPTIONAL },
  { id: '0010-ai-usage-task', script: 'prisma/backfill-ai-usage-task.mjs', once: false, optional: true, why: ALWAYS_OPTIONAL },
  // PageView by viewer, EmailLog by the one org holding the address (#1556).
  // Numbered after the list's end, placed before 0011 on purpose.
  { id: '0032-telemetry-org', script: 'prisma/backfill-telemetry-org.mjs', once: false, optional: true, why: 'Tenant attribution: non-blocking like its siblings 0006–0010.' },
  // Tenant backfill (#1557): exits non-zero when a nullable orgId column still
  // holds NULLs after its retry passes. An incomplete run is the one thing that
  // must block MT_ENFORCE_ISOLATION, so its failure is announced loudly.
  {
    id: '0011-organization',
    script: 'prisma/backfill-organization.mjs',
    once: false,
    optional: true,
    why: ALWAYS_OPTIONAL,
    failNote: 'org backfill FAILED — it may be incomplete; do NOT enable MT_ENFORCE_ISOLATION until it runs green (#1557).',
  },
  // CompanyNeed → Requisition (#1385). Never actually ran before #1540: the
  // script was not in the image.
  // Since #1875 this also re-points a converted twin instead of duplicating it.
  { id: '0012-requisitions', script: 'scripts/backfill-requisitions.mjs', once: false, optional: true, why: ALWAYS_OPTIONAL },
  // One Application per CompanyInterest that names a requisition (#1828).
  // Only ever adds rows. Same image gap as the line above.
  { id: '0013-applications', script: 'scripts/backfill-applications.mjs', once: false, optional: true, why: ALWAYS_OPTIONAL },
  // API key lifecycle (#1545) + tenant anchor (#1466). AFTER 0011.
  { id: '0014-api-key-lifecycle', script: 'prisma/backfill-api-key-lifecycle.mjs', once: false, optional: true, why: ALWAYS_OPTIONAL },
  // Admin tiers (#1567): every ADMIN without a tier gets ORG_ADMIN — the power
  // the role already carried. Fills NULLs only, never the platform tier.
  { id: '0015-admin-level', script: 'prisma/backfill-admin-level.mjs', once: false, optional: true, why: ALWAYS_OPTIONAL },
  // Baseline the scheduled-job backlog so the first cron tick doesn't email out
  // history. One-shot (it also self-skips on Setting 'cronBaselineAt').
  { id: '0016-cron-baseline', script: 'prisma/backfill-cron-baseline.mjs', once: true, optional: true, why: ALWAYS_OPTIONAL },
  // completedAt for relations COMPLETED before the column existed (#854).
  { id: '0017-relation-completed-at', script: 'prisma/backfill-relation-completed-at.mjs', once: false, optional: true, why: ALWAYS_OPTIONAL },
  // MentorshipRelation.lifecycleState from `status` (#1768) — the backfill half
  // of expand → backfill → contract; only touches rows that disagree.
  { id: '0018-relation-lifecycle', script: 'prisma/backfill-relation-lifecycle.mjs', once: false, optional: true, why: ALWAYS_OPTIONAL },
  // Remove the Meeting rows the old recurring generator materialised (#1110).
  { id: '0019-series-meetings', script: 'prisma/backfill-series-meetings.mjs', once: false, optional: true, why: ALWAYS_OPTIONAL },
  // Grandfather pre-paywall SAML SSO tenants onto ENTERPRISE (#1742).
  { id: '0020-sso-plan', script: 'prisma/backfill-sso-plan.mjs', once: false, optional: true, why: ALWAYS_OPTIONAL },
  // Pre-#1806 review notes out of rejectReason into adminNote.
  { id: '0021-mentor-application-admin-note', script: 'prisma/backfill-mentor-application-admin-note.mjs', once: false, optional: true, why: ALWAYS_OPTIONAL },
  // WeeklyReportReminder.recipientId (#2287); also prints the duplicate count
  // the @@unique contract step is gated on.
  { id: '0022-weekly-report-reminder-recipient', script: 'prisma/backfill-weekly-report-reminder-recipient.mjs', once: false, optional: true, why: ALWAYS_OPTIONAL },
  // Relations stranded on APPLICATION_100 in a tenant whose stages lack it
  // (#1634). Dry-run by default; `--apply` is the deploy's deliberate choice.
  { id: '0023-relation-start-stage', script: 'prisma/backfill-relation-start-stage.mjs', args: ['--apply'], once: false, optional: true, why: ALWAYS_OPTIONAL },
  // A Subscription row per Organization matching its old plan (#1731).
  { id: '0024-org-subscription', script: 'prisma/backfill-org-subscription.mjs', once: false, optional: true, why: ALWAYS_OPTIONAL },
  // premiumAnalytics setting → ADVANCED_ANALYTICS grants (#1740); deletes the
  // dead setting rows so a re-run grants nothing.
  { id: '0025-premium-analytics-entitlement', script: 'prisma/backfill-premium-analytics-entitlement.mjs', once: false, optional: true, why: ALWAYS_OPTIONAL },
  // Grandfathers (#1740, #1738, #1744): every org that exists when a gate goes
  // live keeps the feature, ONCE — orgs created later must not inherit it.
  // They also carry their own marker note; `once` makes the ledger say so.
  { id: '0026-report-export-grandfather', script: 'prisma/backfill-report-export-grandfather.mjs', once: true, optional: true, why: ALWAYS_OPTIONAL },
  { id: '0027-ai-package-grandfather', script: 'prisma/backfill-ai-package-grandfather.mjs', once: true, optional: true, why: ALWAYS_OPTIONAL },
  { id: '0028-integrations-api-grandfather', script: 'prisma/backfill-integrations-api-grandfather.mjs', once: true, optional: true, why: ALWAYS_OPTIONAL },
  // Re-split skill lists stored as one blob (#2314). BEFORE 0030.
  { id: '0029-skill-lists', script: 'prisma/backfill-skill-lists.mjs', args: ['--apply'], once: false, optional: true, why: ALWAYS_OPTIONAL },
  // Map free-text skills onto the taxonomy (#1819); skipDuplicates makes a
  // re-run a no-op.
  { id: '0030-skill-taxonomy', script: 'prisma/backfill-skill-taxonomy.mjs', args: ['--apply'], once: false, optional: true, why: ALWAYS_OPTIONAL },
  // Legacy User.skillLevels onto the UserSkill rows 0030 created (#1822).
  // AFTER 0030. Fills only a row with no level and no history, so a re-run is
  // a no-op and a level set or cleared since is never overwritten.
  { id: '0034-skill-levels', script: 'prisma/backfill-skill-levels.mjs', args: ['--apply'], once: false, optional: true, why: 'New in #1822; optional like every skill backfill — the JSON column stays the written record until the contract step.' },
  // Document review chain (#1859): documents older than Document.reviewStatus
  // read PENDING; the ones that never entered a chain (no DocumentReview row)
  // become APPROVED. Only updates PENDING rows without a review step, so a
  // second run reports updated=0 — and NONE-mode requirements ignore PENDING,
  // so nothing turns red before it runs.
  { id: '0031-document-reviews', script: 'prisma/backfill-document-reviews.mjs', once: false, optional: true, why: ALWAYS_OPTIONAL },
  // Stage deadlines for relations already sitting in a stage when its service
  // level was configured (#1640), dated from the stage ENTRY. Past-due ones get
  // their reminder stamp (and a snoozed breach) in the same write, so the next
  // 09:00 sweep adopts them silently instead of mailing every mentor. ONCE: a
  // deadline a person later clears must not come back on every deploy. After
  // the push — it reads StageSla.scope/cohortId/mentorId.
  {
    id: '0033-stage-deadlines',
    script: 'prisma/backfill-stage-deadlines.mjs',
    args: ['--apply'],
    once: true,
    optional: true,
    why: 'A derived convenience column: a failed fill leaves relations exactly as before #1640, so it must not block a deploy.',
  },
];
