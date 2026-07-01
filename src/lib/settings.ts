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
