import { prisma } from '@/lib/prisma';

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
  // Monthly cap on AI provider calls across the org (Faz 2, #537). Every AI
  // feature consumes from this pool via runAiGated; '0' disables AI calls
  // entirely. Metered in AiUsage; resets each calendar month.
  aiMonthlyQuota: '200',
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

export async function getSettings(): Promise<Record<SettingKey, string>> {
  const rows = await prisma.setting.findMany();
  const map: Record<string, string> = { ...SETTING_DEFAULTS };
  for (const r of rows) if (r.key in SETTING_DEFAULTS) map[r.key] = r.value;
  return map as Record<SettingKey, string>;
}

// Read a single setting (falls back to its default).
export async function getSetting(key: SettingKey): Promise<string> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row?.value ?? SETTING_DEFAULTS[key];
}
