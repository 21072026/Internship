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
//   • no default lead owner — form leads wait in the unowned list (#2580);
//   • outbound approval off — automated lead mail leaves without review (#2960).
// The summary also counts `claimableLeads`: lead records with no login yet but a
// real address, the only ones forgot/reset could turn into a working account
// (#2578, a number for the maintainer's decision — no address is ever printed).
// Before them, one deployment-wide WARNING when the marketing product is served
// (MARKETING_HOSTS) but its sender identity is incomplete (#2578).
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
    `defaultOwner=${org.defaultLeadOwnerId ? 'set' : '—'} bccToCrm=${org.crmBcc} ` +
    `outboundApproval=${org.outboundApproval} claimableLeads=${org.claimableLeads}`;
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
  if (org.outboundApproval === 'off') gaps.push('automated lead mail leaves without review: /admin/settings → outbound approval');
  return { summary, gaps };
}

/**
 * The deployment-wide readiness line for the marketing sender (#2578), or null
 * when there is nothing to say. Postal campaigns refuse to print or post while
 * the marketing world has no complete sender of its own; this surfaces that in
 * the deploy log BEFORE an admin hits the refusal. Only when the deployment
 * serves the marketing product at all (MARKETING_HOSTS set).
 *
 * Plain-ESM mirror of `marketingOperatorConfigured()` in src/lib/imprint.ts (the
 * deploy runs this under Node 20, which cannot import TS);
 * scripts/test/marketing-operator-guard.test.mjs keeps the two in step.
 */
export function marketingOperatorWarning(env = process.env) {
  if (!(env.MARKETING_HOSTS ?? '').trim()) return null;
  const set = (k) => (env[k] ?? '').trim() !== '';
  const address = (env.MARKETING_OPERATOR_ADDRESS ?? '').split(/[|\n]/).some((l) => l.trim() !== '');
  const missing = [
    !set('MARKETING_OPERATOR_NAME') && 'MARKETING_OPERATOR_NAME',
    !set('MARKETING_OPERATOR_EMAIL') && 'MARKETING_OPERATOR_EMAIL',
    !address && 'MARKETING_OPERATOR_ADDRESS',
  ].filter(Boolean);
  if (missing.length === 0) return null;
  return `WARNING marketing operator: ${missing.join(', ')} not set — postal campaigns refuse to print and post (409 operator_missing) until the env file names the marketing sender (docs/marketing-vertical/postal-campaigns.md § Operatör adımı)`;
}

/**
 * The org's effective outbound-approval mode (#2960): plain-ESM mirror of
 * `parseOutboundApprovalMode()` (src/lib/outboundApprovalRule.ts) over the
 * stored setting whose default is 'off' (src/lib/settings.ts). Only MARKETING
 * orgs reach this report, and that is the vertical where `outboundApprovalApplies()`
 * is true, so the stored value IS the effective one. Blank and 'off' are off;
 * anything else reads as 'lead_mail' — the rule's safe side of a misspelt switch.
 * scripts/test/marketing-org-report.test.mjs holds it to both files.
 */
export function outboundApprovalLabel(stored) {
  const v = stored === undefined || stored === null ? '' : String(stored).trim();
  return v === '' || v === 'off' ? 'off' : 'lead_mail';
}

// Plain-ESM mirrors of src/lib/menteeAccount.ts (the deploy runs under Node 20,
// which cannot import TS); scripts/test/marketing-org-report.test.mjs compares them.
export const NO_LOGIN_PASSWORDS = ['!created-no-login', '!imported-no-login', '!apply-no-login'];
const PLACEHOLDER_EMAIL_DOMAIN = 'import.local';
const ERASED_EMAIL_DOMAIN = 'erased.local';
const domainOf = (email) => String(email ?? '').split('@')[1]?.toLowerCase() ?? '';
/** Mirrors `isPendingActivation()`: never had a password, nobody can sign in as it. */
export function isPendingActivation(user) {
  return NO_LOGIN_PASSWORDS.includes(user.password);
}
/** Mirrors `isPlaceholderEmail()`: a generated stand-in, not a mailbox. */
export function isPlaceholderEmail(email) {
  return domainOf(email) === PLACEHOLDER_EMAIL_DOMAIN;
}
/** Mirrors `isErasedAccount()`: an anonymised record, not a person. */
export function isErasedAccount(user) {
  return domainOf(user.email) === ERASED_EMAIL_DOMAIN;
}

/**
 * Lead records (MENTEE rows) a forgot/reset mail could turn into a working
 * login: no password yet AND an address someone reads. A stand-in address
 * (`@import.local`) receives nothing and an erased record is not a person, so
 * neither counts. A count only — the report never prints an address.
 */
export function countClaimableLeads(rows) {
  return rows.filter((r) => isPendingActivation(r) && !isPlaceholderEmail(r.email) && !isErasedAccount(r)).length;
}

/** '' = MARKETING default (on); otherwise the stored choice. Mirrors crmBccEnabledFor(). */
export function crmBccLabel(stored) {
  if (stored === 'false') return 'off';
  return 'on';
}

async function main() {
  // Env only, so it is printed even when the database is unreachable.
  const operatorWarning = marketingOperatorWarning();
  if (operatorWarning) console.log(operatorWarning);
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
      const [stages, admins, reps, settings, noLoginLeads] = await Promise.all([
        prisma.pipelineStage.findMany({ where: { orgId: o.id }, select: { key: true } }),
        prisma.user.count({ where: { orgId: o.id, role: 'ADMIN', isActive: true } }),
        prisma.user.count({ where: { orgId: o.id, role: 'MENTOR', isActive: true } }),
        prisma.setting.findMany({
          where: { orgId: o.id, key: { in: ['defaultLeadOwnerId', 'crmBccEnabled', 'outboundApproval'] } },
          select: { key: true, value: true },
        }),
        // Read only to be counted (countClaimableLeads); never printed.
        prisma.user.findMany({
          where: { orgId: o.id, role: 'MENTEE', password: { in: NO_LOGIN_PASSWORDS } },
          select: { email: true, password: true },
        }),
      ]);
      const setting = (k) => settings.find((s) => s.key === k)?.value ?? '';
      const { summary, gaps } = marketingOrgReport({
        ...o,
        stageKeys: stages.map((s) => s.key),
        activeAdmins: admins,
        activeReps: reps,
        defaultLeadOwnerId: setting('defaultLeadOwnerId') || null,
        crmBcc: crmBccLabel(setting('crmBccEnabled')),
        outboundApproval: outboundApprovalLabel(setting('outboundApproval')),
        claimableLeads: countClaimableLeads(noLoginLeads),
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
