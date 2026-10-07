// Report-only: is each MARKETING org ready for a sales team? (#2579)
//
//   node prisma/check-marketing-orgs.mjs
//
// The deploy log (infra/deploy-prod.sh) runs this so the maintainer can verify
// the production MARKETING org WITHOUT a database connection — the data-access
// policy keeps contributors off prod data, and "is the org set up" was the one
// question only a prod query could answer. Never writes, always exits 0, prints
// no personal data (counts and ids only).
//
// One line per MARKETING org, then one line per gap with what to do about it:
//   • no TRIAL_ACTIVE / TRIAL_EXPIRED stage rows — the org runs on the INTERNSHIP
//     default pipeline (resolvePipelineStages() falls back to it when an org has
//     no rows), so trial windows, reminders and expiry silently never happen;
//   • no public host — the landing's demo form is closed (#2569);
//   • no active ADMIN, or no active rep (MENTOR) — nobody can work the funnel;
//   • no default lead owner — form leads wait in the unowned list (#2580).
import { PrismaClient } from '@prisma/client';

const TRIAL_KEYS = ['TRIAL_ACTIVE', 'TRIAL_EXPIRED'];

/**
 * The report for one org, from plain facts (unit-tested without a database in
 * scripts/test/marketing-org-report.test.mjs). Returns the summary line and the
 * gap lines.
 */
export function marketingOrgReport(org) {
  const missingTrial = TRIAL_KEYS.filter((k) => !org.stageKeys.includes(k));
  const summary =
    `${org.slug} (${org.id}): plan=${org.plan} host=${org.publicHost ?? '—'} brand=${org.brandName ?? '—'} ` +
    `stages=${org.stageKeys.length} admins=${org.activeAdmins} reps=${org.activeReps} ` +
    `defaultOwner=${org.defaultLeadOwnerId ? 'set' : '—'} bccToCrm=${org.crmBcc}`;
  const gaps = [];
  if (org.stageKeys.length === 0) {
    gaps.push('no pipeline stage rows: the org runs on the INTERNSHIP default pipeline — apply the starter pack (/admin/settings → starter pack), which seeds the marketing funnel');
  } else if (missingTrial.length > 0) {
    gaps.push(`missing stage(s) ${missingTrial.join(', ')}: trial windows, reminders and expiry will not run`);
  }
  if (!org.publicHost) gaps.push(`no public host: the demo form is closed — node prisma/set-public-host.mjs --org ${org.slug} --host <host>`);
  if (org.activeAdmins === 0) gaps.push('no active ADMIN');
  if (org.activeReps === 0) gaps.push('no active sales rep (MENTOR): invite the team from /admin/users');
  if (!org.defaultLeadOwnerId) gaps.push('no default lead owner: form leads wait in /admin/company-inquiries until an admin assigns them');
  return { summary, gaps };
}

/** '' = MARKETING default (on); otherwise the stored choice. Mirrors crmBccEnabledFor(). */
export function crmBccLabel(stored) {
  if (stored === 'false') return 'off';
  return 'on';
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const orgs = await prisma.organization.findMany({
      where: { vertical: 'MARKETING' },
      select: { id: true, slug: true, plan: true, publicHost: true, brandName: true },
      orderBy: { createdAt: 'asc' },
    });
    if (orgs.length === 0) {
      console.log('marketing orgs: none — create one with the super-admin org form (vertical MARKETING) before inviting the team');
      return;
    }
    for (const o of orgs) {
      const [stages, admins, reps, settings] = await Promise.all([
        prisma.pipelineStage.findMany({ where: { orgId: o.id }, select: { key: true } }),
        prisma.user.count({ where: { orgId: o.id, role: 'ADMIN', isActive: true } }),
        prisma.user.count({ where: { orgId: o.id, role: 'MENTOR', isActive: true } }),
        prisma.setting.findMany({ where: { orgId: o.id, key: { in: ['defaultLeadOwnerId', 'crmBccEnabled'] } }, select: { key: true, value: true } }),
      ]);
      const setting = (k) => settings.find((s) => s.key === k)?.value ?? '';
      const { summary, gaps } = marketingOrgReport({
        ...o,
        stageKeys: stages.map((s) => s.key),
        activeAdmins: admins,
        activeReps: reps,
        defaultLeadOwnerId: setting('defaultLeadOwnerId') || null,
        crmBcc: crmBccLabel(setting('crmBccEnabled')),
      });
      console.log(`marketing org ${summary}`);
      for (const g of gaps) console.log(`  ! ${g}`);
      if (gaps.length === 0) console.log('  ✓ ready');
    }
  } finally {
    await prisma.$disconnect();
  }
}

// Run only as a CLI, so the unit test can import the report.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    // Report only: a failure here must never fail a deploy.
    console.error(`check-marketing-orgs: ${e.message}`);
  });
}
