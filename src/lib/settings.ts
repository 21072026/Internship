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
