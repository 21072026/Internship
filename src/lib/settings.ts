import { prisma } from '@/lib/prisma';
import { ambientOrgId, runUnscoped } from '@/lib/tenantAmbient';

// ── Settings resolution (#1553) ──────────────────────────────────────────────
//
// `Setting` is keyed by (orgId, key). A row with `orgId = NULL` is the GLOBAL
// layer; a row with an orgId is one tenant's override. Every read resolves in
// exactly this order, and this file is the ONLY place that rule is written:
//
//   1. the row for the resolved org  (orgId = <tenant>)
//   2. the global row                (orgId = NULL)
//   3. SETTING_DEFAULTS              (the code default, below)
//
// Which org a call resolves to: an explicit `orgId` argument wins; otherwise the
// org bound to the current request by `withTenantScope()` (`currentOrgId()`);
// otherwise none, which means the global layer alone. A single-tenant
// installation — and every request made while `MT_ENFORCE_ISOLATION` is off —
// therefore reads and writes the global rows exactly as it did before, so the
// existing rows keep working untouched as the platform-wide defaults.
//
// WHY THESE QUERIES RUN UNSCOPED: `Setting` is registered in `TENANT_MODELS`
// (src/lib/orgContext.ts), so with enforcement on the tenant middleware would
// rewrite every query here to `where: { orgId: <tenant> }` — which is precisely
// the filter that would hide the global fallback row and make step 2 above
// unreachable. `unscopedSettings()` runs the query with the tenant context
// explicitly cleared so this module can see both layers; the org it then honours
// is computed here from `settingOrgId()`, never taken from request input. The
// registration still earns its keep: any *other* code that touches
// `prisma.setting` directly stays auto-scoped to its own tenant.
//
// Both of those come from `@/lib/tenantAmbient` rather than straight from
// `orgContext`: this module is reachable from a client component (a constant in
// documentAccess.ts, via retention.ts), and orgContext imports node:async_hooks,
// which webpack refuses to bundle for a client graph. The seam has no imports of
// its own; orgContext fills it in when it loads.

// Known settings with their defaults. Stored as strings; parsed on read.
export const SETTING_DEFAULTS = {
  reminderDays: '14',
  supportEmail: '',
  weeklyDigest: 'true',
  // Months of inactivity (unassigned + deactivated) before a candidate is
  // flagged "stale" for GDPR retention review. Informational only — no
  // automatic deletion; an admin reviews and erases manually.
  retentionMonths: '12',
  // Role-based two-factor enforcement. 'off' = optional for everyone;
  // 'admins' = required for ADMIN; 'admins_mentors' = required for ADMIN+MENTOR.
  // Users in scope are held at a 2FA-setup gate until they enable it.
  require2fa: 'off',
  // Premium early-access window (#531): number of days a newly-hireable
  // (HIREABLE_600) candidate is visible in talent-pool search ONLY to companies
  // holding the EARLY_ACCESS entitlement, before opening to all subscribers.
  // '0' disables the window (everyone sees new candidates immediately).
  earlyAccessWindowDays: '7',
  // Premium analytics tier (Faz 2, #521/#538): unlocks cohort comparison (and
  // future export/scheduled reports) on the admin analytics page. Off by
  // default — basic analytics stay free. Single-tenant placeholder for real
  // billing; becomes a per-tenant entitlement with Faz 3 multi-tenancy.
  premiumAnalytics: 'false',
  // Open sign-up policy. 'auto' (default) = a self-registered account activates
  // itself the moment its email is verified, so the front door is genuinely
  // open; 'manual' = it stays inactive and waits for an admin (pendingApproval),
  // which is the escape hatch if sign-ups ever need vetting or get spammed.
  // Invited users are unaffected — an invitation already proves the email.
  selfRegistration: 'auto',
  // Monthly cap on AI provider calls across the org (Faz 2, #537). Every AI
  // feature consumes from this pool via runAiGated; '0' disables AI calls
  // entirely. Metered in AiUsage; resets each calendar month.
  aiMonthlyQuota: '200',
  // Negative-outcome communication (#830). 'false' (default) means reaching an
  // outcome stage notifies the mentor and prefills a draft — a human reads,
  // edits and sends it. 'true' lets the templated message go out to the mentee
  // automatically. Off by default on purpose: a rejection is the most sensitive
  // text this product writes and the wrong message on the wrong case cannot be
  // recalled.
  outcomeAutoSend: 'false',
  // Blind interview review (#819). 'true' hides a candidate's name, photo and
  // university from an interviewer until that interviewer has submitted their
  // own scorecard. Off by default so nothing changes for an existing
  // installation; an org setting rather than a per-reviewer toggle, because a
  // bias control people opt into is one the reviewers who most need it skip.
  blindReview: 'false',
  // Newsletter cadence (#1469). 'off' (default) means nothing is ever queued
  // automatically and every issue is scheduled by hand. 'weekly' / 'biweekly' /
  // 'monthly' let the daily queue job pick the next unused issue from the
  // curated library and SCHEDULE it — never send it directly, so an admin
  // always has the morning to read, edit or cancel what will go out.
  //
  // Off by default on purpose: the library ships in the repo, but which day a
  // real audience gets mail is a decision for whoever owns that audience.
  newsletterSchedule: 'off',
  // Who an auto-queued issue targets: MENTEE (default), MENTOR or BOTH.
  newsletterAudience: 'MENTEE',
  // Local hour of day an auto-queued issue is scheduled for (0-23).
  newsletterSendHour: '9',
  // Retention windows for the telemetry tables, in days (#1678). The daily
  // `retention.prune` job reads these; the reason for each number lives on its
  // registry entry in src/lib/retentionEntries.ts and in
  // docs/pii-access-lifecycle.md, which is the page an operator is pointed at
  // before changing one. They are deliberately NOT on the settings form: these
  // are operator decisions with a data-protection consequence, not preferences,
  // and a number typed into a form without the reasoning next to it is how a
  // published retention promise gets contradicted by accident.
  //
  // A value of 0, a negative or an unparseable one falls back to the entry's
  // default rather than deleting everything — a corrupted setting row must not
  // be able to empty a table.
  //
  // The security ledger: longest window, because it is what an incident review
  // reads. Evidence rows survive it; their ip/userAgent do not.
  activityLogRetentionDays: '365',
  // Per-user browsing history: shortest window, because it is the most invasive
  // and the least useful old — the one surface that reads it looks back 30 days
  // at most.
  pageViewRetentionDays: '180',
  // A push subscription neither delivered to nor re-confirmed within this
  // window, whose owner has also been quiet for it, is dead weight.
  pushSubscriptionStaleDays: '180',
  // Finished queue rows (SUCCEEDED/CANCELLED). DEAD_LETTER is never pruned.
  jobRetentionDays: '30',
  // In-app notification rows (#1646). Unlike the four telemetry windows above
  // this one IS on the settings form, because it is the one an org actually has
  // an opinion about: a notification is a rendered sentence about a person plus
  // a link to their record — the same kind of data EmailLog is pruned for — and
  // how long a bell keeps its history is a programme decision, not an
  // infrastructure one.
  //
  // 180 days, matching PageView: half a year is far longer than anybody scrolls
  // back through a bell, and it is the window this product already publishes for
  // the other per-user history table, so there is one number to defend rather
  // than two. `0` means keep forever (the pre-#1646 behaviour, chosen
  // explicitly rather than by accident).
  //
  // Two rails live in the prune itself and no setting can lower them: an UNREAD
  // row is never deleted, and nothing younger than
  // NOTIFICATION_RETENTION_FLOOR_DAYS (30) is deleted whatever this says.
  notificationRetentionDays: '180',
  // Board work-in-progress limit (#1439): a pipeline column holding more than
  // this many candidates gets an amber count, so a bottleneck stands out.
  // Advisory only — it never blocks a move.
  //
  // 8 because that is the number the board shipped with as a hardcoded
  // constant, so an installation that configures nothing sees the board it saw
  // yesterday. It was sized for one mentor's working set and does not survive
  // growth: at 308 relations every one of the thirteen columns breached it, and
  // a warning that fires everywhere is decoration. Hence a setting, a per-stage
  // override on `StageSla.wipLimit` (a funnel mouth and a hiring column have
  // very different healthy depths), and '0' here to switch WIP warnings off
  // entirely rather than pick a number nobody will act on.
  boardWipLimit: '8',
  // Grace period, in days, before the retention sweep ANONYMIZES an orphan
  // applicant account — a /apply account whose mentor declined and which shows
  // no other sign of life (#1780). The rule itself, and why 90 days, live in
  // src/lib/orphanApplicant.ts; the dry run an admin reads before it happens is
  // /admin/retention. Same fallback contract as the windows above: 0, negative
  // or unparseable falls back to the entry's default rather than erasing
  // everything. Unlike the windows above it is read from the GLOBAL layer only:
  // the sweep runs with no tenant bound and crosses every org in one pass, so a
  // per-tenant override would be written and never read — the admin dry run
  // reads the same layer deliberately, so its countdown is the one that fires.
  orphanApplicantGraceDays: '90',
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

// The org a settings call applies to. An explicit argument wins (including an
// explicit `null`, meaning "the global layer"); otherwise the request's bound
// tenant; otherwise none.
export function settingOrgId(orgId?: string | null): string | null {
  if (orgId !== undefined) return orgId;
  return ambientOrgId() ?? null;
}

// Run a Setting query with the tenant auto-filter switched off — see the header:
// the global fallback row (orgId = NULL) is invisible to a scoped query. This
// binds an empty tenant context, which the middleware skips; with enforcement
// off (or the engine not loaded at all) it is a plain passthrough.
function unscopedSettings<T>(fn: () => Promise<T>): Promise<T> {
  return runUnscoped(fn);
}

type SettingRow = { orgId: string | null; key: string; value: string };

// Both layers for `org` (tenant rows + global rows), in one query.
function loadRows(org: string | null, key?: SettingKey): Promise<SettingRow[]> {
  return unscopedSettings(() =>
    prisma.setting.findMany({
      where: {
        ...(key ? { key } : {}),
        OR: org ? [{ orgId: org }, { orgId: null }] : [{ orgId: null }],
      },
      select: { orgId: true, key: true, value: true },
    }),
  );
}

// All settings for an org, with the global row and then the code default filled
// in for every key the org has not overridden.
export async function getSettings(orgId?: string | null): Promise<Record<SettingKey, string>> {
  const org = settingOrgId(orgId);
  const rows = await loadRows(org);
  const map: Record<string, string> = { ...SETTING_DEFAULTS };
  // Global layer first, tenant overrides on top — order matters, not the order
  // the rows happen to come back in.
  for (const r of rows) if (r.orgId === null && r.key in SETTING_DEFAULTS) map[r.key] = r.value;
  for (const r of rows) if (r.orgId !== null && r.key in SETTING_DEFAULTS) map[r.key] = r.value;
  return map as Record<SettingKey, string>;
}

// Read a single setting: tenant row → global row → default.
export async function getSetting(key: SettingKey, orgId?: string | null): Promise<string> {
  const org = settingOrgId(orgId);
  const rows = await loadRows(org, key);
  const tenant = org ? rows.find((r) => r.orgId === org) : undefined;
  const global = rows.find((r) => r.orgId === null);
  return tenant?.value ?? global?.value ?? SETTING_DEFAULTS[key];
}

// Write one setting into a single layer — the org resolved exactly as reads
// resolve it, so a tenant admin can only ever write their own org's row and a
// single-tenant installation keeps writing the global one.
//
// `orgId` is a SERVER-SIDE argument (seeds, jobs, tests). Never pass a value
// that came from a request body: the authorization for this write is that the
// org is derived from the session's bound context, not from input.
//
// Deliberately a read-modify-write rather than `prisma.setting.upsert`: the
// natural key contains a nullable column, so the compound unique cannot address
// the global (orgId = NULL) row.
export async function setSetting(key: SettingKey, value: string, orgId?: string | null): Promise<void> {
  const org = settingOrgId(orgId);
  await unscopedSettings(async () => {
    const existing = await prisma.setting.findFirst({ where: { orgId: org, key }, select: { id: true } });
    if (existing) await prisma.setting.update({ where: { id: existing.id }, data: { value } });
    else await prisma.setting.create({ data: { orgId: org, key, value } });
  });
}
