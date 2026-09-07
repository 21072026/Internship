import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { z } from 'zod';
import { getSettings, setSetting, SETTING_DEFAULTS, type SettingKey } from '@/lib/settings';
import { withTenantScope } from '@/lib/orgContext';
import { logActivity } from '@/lib/activity';

// GET — current settings for the caller's tenant, resolved org row → global row
// → code default (see src/lib/settings.ts).
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return withTenantScope(session, async () => NextResponse.json({ settings: await getSettings() }));
}

const schema = z.object({
  reminderDays: z.string().regex(/^\d{1,3}$/).optional(),
  supportEmail: z.string().email().or(z.literal('')).optional(),
  weeklyDigest: z.enum(['true', 'false']).optional(),
  retentionMonths: z.string().regex(/^\d{1,3}$/).optional(),
  require2fa: z.enum(['off', 'admins', 'admins_mentors']).optional(),
  selfRegistration: z.enum(['auto', 'manual']).optional(),
  outcomeAutoSend: z.enum(['true', 'false']).optional(),
  blindReview: z.enum(['true', 'false']).optional(),
  earlyAccessWindowDays: z.string().regex(/^\d{1,3}$/).optional(),
  premiumAnalytics: z.enum(['true', 'false']).optional(),
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
});

// PUT — write one or more settings for the CALLER'S OWN tenant.
//
// The layer written is never taken from the request body: `setSetting` derives it
// from the org bound by `withTenantScope` below (and falls back to the global row
// when no org is bound, which is what a single-tenant installation does today),
// so tenant B's admin cannot reach tenant A's row no matter what it posts.
export async function PUT(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  return withTenantScope(session, async () => {
    const entries = Object.entries(parsed.data).filter(([k]) => k in SETTING_DEFAULTS) as [SettingKey, string][];
    // Sequential on purpose: two writes for the same (org, key) must not race
    // the read-modify-write inside setSetting into a duplicate row.
    for (const [key, value] of entries) await setSetting(key, value);
    await logActivity({ action: 'settings.update', actorId: session.user.id, actorEmail: session.user.email ?? null });
    return NextResponse.json({ settings: await getSettings() });
  });
}
