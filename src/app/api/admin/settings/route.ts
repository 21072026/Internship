import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { z } from 'zod';
import { isGlobalSettingKey, SETTING_DEFAULTS, type SettingKey } from '@/lib/settings';
import { revertSetting, writeSetting, type SettingWriteResult } from '@/lib/settingsWrite';
import { requirePermission } from '@/lib/authz';
import { resolveSettings } from '@/lib/settingsResolver';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { isSuperAdmin, logCrossTenantDenial } from '@/lib/superAdmin';
import { withTenantScope } from '@/lib/orgContext';
import { logActivity } from '@/lib/activity';
import { MAX_DECISION_WINDOW_DAYS, MAX_TRIAL_LENGTH_DAYS } from '@/lib/trialReminderRule';
import { findLeadOwner } from '@/lib/leadOwner';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { salesTargetApplies } from '@/lib/salesTargetRule';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { isStorableMinLength } from '@/lib/passwordPolicyRule';
import { REQUIRE_2FA_MODES } from '@/lib/twoFactorPolicyRule';
import { OUTBOUND_APPROVAL_MODES, outboundApprovalApplies } from '@/lib/outboundApprovalRule';

// GET — the EFFECTIVE settings of the caller's tenant: its own row → the global
// row → the code default (see src/lib/settings.ts). The org is passed
// explicitly rather than read from the bound context, so an org-less session
// reads the default org's values — the same org its PUT writes (#2628).
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const orgId = await settingsOrgOf(session);
  return withTenantScope(session, async () => {
    const resolved = await resolveSettings({ orgId });
    // `sources` drives the "set here / inherited" badge of each key (#1623).
    return NextResponse.json({ settings: resolved.raw, sources: resolved.sources });
  });
}

// The activity entry of one real change (#1623): the key as the target and the
// redacted before → after as the detail — a `redact` key reads "[redacted]",
// never its value. ActivityLog.detail is a VARCHAR, hence the clip.
async function logSettingChange(
  result: NonNullable<SettingWriteResult>,
  session: { user: { id: string; email?: string | null } },
  request: Request,
  action = 'settings.update',
) {
  const show = (v: string | number | boolean | null) => (v === null ? '∅' : String(v));
  const detail = `${result.scope}: ${show(result.change.from)} → ${show(result.change.to)}`;
  await logActivity({
    action,
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'Setting',
    targetId: result.change.field,
    detail: detail.length > 180 ? `${detail.slice(0, 179)}…` : detail,
    request,
  });
}

const schema = z.object({
  reminderDays: z.string().regex(/^\d{1,3}$/).optional(),
  supportEmail: z.string().email().or(z.literal('')).optional(),
  weeklyDigest: z.enum(['true', 'false']).optional(),
  retentionMonths: z.string().regex(/^\d{1,3}$/).optional(),
  // The vocabulary is src/lib/twoFactorPolicyRule.ts (#1644): `all` holds
  // every role — MENTEE, COMPANY and SOURCE included — at the setup gate.
  require2fa: z.enum(REQUIRE_2FA_MODES).optional(),
  // Password policy (#1544). The minimum is range-checked below against the
  // floor/ceiling of src/lib/passwordPolicyRule.ts, not only by shape.
  passwordMinLength: z.string().regex(/^\d{1,3}$/).optional(),
  passwordRequireUpper: z.enum(['true', 'false']).optional(),
  passwordRequireLower: z.enum(['true', 'false']).optional(),
  passwordRequireDigit: z.enum(['true', 'false']).optional(),
  passwordRequireSymbol: z.enum(['true', 'false']).optional(),
  breachedPasswordCheck: z.enum(['true', 'false']).optional(),
  selfRegistration: z.enum(['auto', 'manual']).optional(),
  outcomeAutoSend: z.enum(['true', 'false']).optional(),
  blindReview: z.enum(['true', 'false']).optional(),
  autoAdvanceOnOfferAccept: z.enum(['true', 'false']).optional(),
  earlyAccessWindowDays: z.string().regex(/^\d{1,3}$/).optional(),
  aiMonthlyQuota: z.string().regex(/^\d{1,6}$/).optional(),
  // Board WIP limit (#1439). `0` is meaningful and must pass: it switches the
  // amber column warnings off entirely. Four digits is far past any real
  // pipeline column, and a per-stage override lives on the stage-SLA endpoint.
  boardWipLimit: z.string().regex(/^\d{1,4}$/).optional(),
  // Newsletter cadence (#1469). Edited from /admin/newsletters rather than the
  // settings page — the three of them only mean anything next to the issue
  // history they drive.
  newsletterSchedule: z.enum(['off', 'weekly', 'biweekly', 'monthly']).optional(),
  newsletterAudience: z.enum(['MENTEE', 'MENTOR', 'BOTH']).optional(),
  newsletterSendHour: z.string().regex(/^(?:[0-9]|1[0-9]|2[0-3])$/).optional(),
  // Retention windows (#1678). Writable here — an operator can widen or narrow
  // a window without a deploy — but deliberately absent from the settings form:
  // the reasoning that makes each number defensible lives in
  // docs/pii-access-lifecycle.md, and a field on a form separates the number
  // from it. `\d{1,4}` bounds them at ~27 years; the job itself rejects 0 and
  // falls back to the entry default, so an empty window cannot empty a table.
  activityLogRetentionDays: z.string().regex(/^\d{1,4}$/).optional(),
  pageViewRetentionDays: z.string().regex(/^\d{1,4}$/).optional(),
  pushSubscriptionStaleDays: z.string().regex(/^\d{1,4}$/).optional(),
  jobRetentionDays: z.string().regex(/^\d{1,4}$/).optional(),
  domainEventRetentionDays: z.string().regex(/^\d{1,4}$/).optional(),
  companyInquiryRetentionDays: z.string().regex(/^\d{1,4}$/).optional(),
  // The AuditLog window (#1585). The sweep raises it to a 365-day floor.
  auditLogRetentionDays: z.string().regex(/^\d{1,4}$/).optional(),
  // Repeat-read suppression window for the access log, in minutes (#2433).
  // Same reasoning as the retention windows above: writable, not on the form.
  // `0` logs every read; the rule clamps anything above a day to a day.
  viewLogWindowMinutes: z.string().regex(/^\d{1,4}$/).optional(),
  // Notification history (#1646). Unlike the four above, this one IS on the
  // settings form — how long a bell keeps its history is a programme decision
  // an org has an opinion about. `0` means keep forever; the prune raises
  // anything else to its 30-day floor and never touches an unread row, so no
  // value posted here can empty a bell.
  notificationRetentionDays: z.string().regex(/^\d{1,4}$/).optional(),
  // The only retention window that governs a PERSON'S ACCOUNT rather than a
  // telemetry row (#1780) — omitting it here made the documented way to widen
  // it a silent no-op, since `z.object` strips unknown keys. Note that the
  // sweep reads this from the GLOBAL layer (it runs with no org bound), so on a
  // multi-tenant installation a per-tenant write would not be the number that
  // fires; the window is an installation-wide decision, like the job itself.
  orphanApplicantGraceDays: z.string().regex(/^\d{1,4}$/).optional(),
  // Monthly broadcast recipient cap (#1754). `''` clears the override and
  // returns the org to its plan's band; a number can only TIGHTEN that band, so
  // accepting it from a tenant admin cannot raise anybody's ceiling. Seven
  // digits is far past any list this product will mail.
  broadcastMonthlyRecipients: z.string().regex(/^\d{1,7}$/).or(z.literal('')).optional(),
  // Trial length for the MARKETING funnel (#2551). 1..MAX_TRIAL_LENGTH_DAYS
  // (the one bound the form and the rule share): a zero-day trial
  // would be stamped as already over and swept into TRIAL_EXPIRED overnight,
  // so 0 is refused here (and would fall back to 30 in the rule regardless).
  trialLengthDays: z
    .string()
    .regex(/^\d{1,3}$/)
    .refine((v) => Number(v) >= 1 && Number(v) <= MAX_TRIAL_LENGTH_DAYS)
    .optional(),
  // The decision window after an expired trial (#2927). 1..MAX like the trial
  // length: 0 would close every window on arrival (and would fall back to 30
  // in the rule regardless).
  decisionWindowDays: z
    .string()
    .regex(/^\d{1,3}$/)
    .refine((v) => Number(v) >= 1 && Number(v) <= MAX_DECISION_WINDOW_DAYS)
    .optional(),
  // Default owner of a new lead (#2580). `''` clears it; any other value must
  // name an active ADMIN/MENTOR of the caller's own org — checked below against
  // the database, because a shape check cannot tell a colleague's id from
  // another tenant's.
  defaultLeadOwnerId: z.string().trim().max(64).optional(),
  // Sales won-deal target + leaderboard (MARKETING only). `''` or `0` = no
  // target; `\d{1,4}` mirrors SALES_TARGET_MAX. Refused below for a vertical
  // without the sales surface, so an INTERNSHIP org can never store a
  // leaderboard switch (leaderboards are a non-goal there).
  salesMonthlyWonTarget: z.string().regex(/^\d{1,4}$/).or(z.literal('')).optional(),
  salesLeaderboardForReps: z.enum(['true', 'false']).optional(),
  // Outbound approval (#2960): hold automated mail to leads and customers for
  // an operator. The sales vertical only — refused below anywhere else, and
  // the rule reads it as 'off' there regardless.
  outboundApproval: z.enum(OUTBOUND_APPROVAL_MODES).optional(),
  // Extra `external_id` header spellings for the marketing import (comma- or
  // newline-separated; parseHeaderAliases() in src/lib/marketingImport.ts).
  importExternalIdAliases: z.string().max(700).optional(),
  // Evaluation due dates (#1891). The stage is checked below against the
  // tenant's resolved stages — a key it does not have would silently never fire.
  evaluationInterimStage: z.string().max(64).regex(/^[A-Za-z0-9_]*$/).optional(),
  evaluationInterimDays: z.string().regex(/^\d{1,3}$/).optional(),
  evaluationFinalStage: z.string().max(64).regex(/^[A-Za-z0-9_]*$/).optional(),
});

// Keys that only exist in a vertical with the sales surface (pipeline, no
// mentorship): the sales target and leaderboard, and the marketing import's
// extra header aliases. Refused for any other vertical.
const SALES_TARGET_KEYS = ['salesMonthlyWonTarget', 'salesLeaderboardForReps', 'importExternalIdAliases'] as const;

// PUT — write one or more settings for the CALLER'S OWN tenant.
//
// The layer written is never taken from the request body. A tenant key goes to
// the caller's org row — `settingsOrgOf(session)`, the default org for an
// org-less session — and NEVER to the global row (#2628): that row is the
// platform default every tenant without its own override inherits, so writing
// it from one tenant's settings form toggled every key here for every tenant
// on the deployment.
//
// The deployment-global keys (GLOBAL_SETTING_KEYS — retention windows, the
// access-log window, the orphan-applicant grace period) have no tenant row by
// definition; they are written to the global row, and only by a super admin. A
// tenant admin posting one gets 403 and nothing in the request is written.
export async function PUT(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  const entries = Object.entries(parsed.data).filter(
    ([k, v]) => k in SETTING_DEFAULTS && v !== undefined,
  ) as [SettingKey, string][];
  const globalKeys = entries.filter(([k]) => isGlobalSettingKey(k)).map(([k]) => k);
  if (globalKeys.length > 0 && !(await isSuperAdmin(session))) {
    await logCrossTenantDenial(session, `PUT /api/admin/settings (${globalKeys.join(',')})`, null);
    return NextResponse.json({ error: 'Forbidden', fields: globalKeys }, { status: 403 });
  }

  const orgId = await settingsOrgOf(session);

  // A minimum below the floor would be clamped back up on read and silently
  // not be what the admin typed; refuse it instead (#1544).
  if (parsed.data.passwordMinLength !== undefined && !isStorableMinLength(parsed.data.passwordMinLength)) {
    return NextResponse.json({ error: 'Validation failed', field: 'passwordMinLength' }, { status: 400 });
  }

  const ownerId = parsed.data.defaultLeadOwnerId;
  if (ownerId && !(await findLeadOwner(orgId, ownerId))) {
    return NextResponse.json({ error: 'Validation failed', field: 'defaultLeadOwnerId' }, { status: 400 });
  }

  for (const field of ['evaluationInterimStage', 'evaluationFinalStage'] as const) {
    const key = parsed.data[field];
    if (key && key !== 'off' && !(await resolvePipelineStages(orgId)).some((stage) => stage.key === key)) {
      return NextResponse.json({ error: 'unknown_stage', field }, { status: 400 });
    }
  }

  const salesKey = SALES_TARGET_KEYS.find((k) => parsed.data[k] !== undefined);
  if (salesKey && !salesTargetApplies(await shellCapabilities(orgId))) {
    return NextResponse.json({ error: 'vertical_mismatch', field: salesKey }, { status: 400 });
  }

  if (parsed.data.outboundApproval !== undefined && !outboundApprovalApplies(await shellCapabilities(orgId))) {
    return NextResponse.json({ error: 'vertical_mismatch', field: 'outboundApproval' }, { status: 400 });
  }

  return withTenantScope(session, async () => {
    // Sequential on purpose: two writes for the same (org, key) must not race
    // the read-modify-write inside writeSetting into a duplicate row.
    // An unchanged key writes nothing — no Setting row, no history row, no log.
    const actor = { id: session.user.id, email: session.user.email ?? null };
    for (const [key, value] of entries) {
      const result = await writeSetting(key, value, isGlobalSettingKey(key) ? null : orgId, { actor });
      if (result) await logSettingChange(result, session, request);
    }
    const resolved = await resolveSettings({ orgId });
    return NextResponse.json({ settings: resolved.raw, sources: resolved.sources });
  });
}

// DELETE ?key= — revert one key to its inherited value (#1623): the caller's
// org row is DELETED, never overwritten with the parent's value, so a later
// change at the global layer flows down again. Authorized like every other
// org-configuration write (`org.settings.write`, src/lib/authzRule.ts); a
// deployment-global key reverts the global row to the code default and is a
// super admin's act, as in PUT. The org is the session's, never the request's.
export async function DELETE(request: Request) {
  const gate = await requirePermission('org.settings.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const key = new URL(request.url).searchParams.get('key') ?? '';
  if (!(key in SETTING_DEFAULTS)) return NextResponse.json({ error: 'Unknown setting' }, { status: 400 });
  const settingKey = key as SettingKey;
  const global = isGlobalSettingKey(settingKey);
  if (global && !(await isSuperAdmin(session))) {
    await logCrossTenantDenial(session, `DELETE /api/admin/settings (${settingKey})`, null);
    return NextResponse.json({ error: 'Forbidden', fields: [settingKey] }, { status: 403 });
  }
  const orgId = await settingsOrgOf(session);
  return withTenantScope(session, async () => {
    const result = await revertSetting(settingKey, global ? null : orgId, {
      actor: { id: session.user.id, email: session.user.email ?? null },
    });
    if (result) await logSettingChange(result, session, request, 'settings.revert');
    const resolved = await resolveSettings({ orgId });
    return NextResponse.json({ reverted: Boolean(result), settings: resolved.raw, sources: resolved.sources });
  });
}
