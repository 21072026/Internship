import type { Locale } from '@/i18n/config';

export const DROP_REASONS = [
  'CANDIDATE_WITHDREW',
  'NO_RESPONSE',
  'ACCEPTED_ELSEWHERE',
  'SCHEDULE_CONFLICT',
  'LOCATION',
  'SKILL_MISMATCH',
  'COMPANY_CANCELLED',
  'PERFORMANCE',
  'OTHER',
] as const;

export type DropReasonCode = (typeof DROP_REASONS)[number];

const LABELS: Record<Locale, Record<DropReasonCode, string>> = {
  tr: {
    CANDIDATE_WITHDREW: 'Aday geri çekildi',
    NO_RESPONSE: 'Yanıt alınamadı',
    ACCEPTED_ELSEWHERE: 'Başka bir teklifi kabul etti',
    SCHEDULE_CONFLICT: 'Takvim uyuşmazlığı',
    LOCATION: 'Konum uyuşmazlığı',
    SKILL_MISMATCH: 'Yetkinlik uyuşmazlığı',
    COMPANY_CANCELLED: 'Şirket tarafından iptal edildi',
    PERFORMANCE: 'Performans nedeniyle',
    OTHER: 'Diğer',
  },
  en: {
    CANDIDATE_WITHDREW: 'Candidate withdrew',
    NO_RESPONSE: 'No response',
    ACCEPTED_ELSEWHERE: 'Accepted another offer',
    SCHEDULE_CONFLICT: 'Schedule conflict',
    LOCATION: 'Location mismatch',
    SKILL_MISMATCH: 'Skill mismatch',
    COMPANY_CANCELLED: 'Company cancelled',
    PERFORMANCE: 'Performance concerns',
    OTHER: 'Other',
  },
  de: {
    CANDIDATE_WITHDREW: 'Kandidat:in hat sich zurückgezogen',
    NO_RESPONSE: 'Keine Rückmeldung',
    ACCEPTED_ELSEWHERE: 'Anderes Angebot angenommen',
    SCHEDULE_CONFLICT: 'Terminkonflikt',
    LOCATION: 'Standort passt nicht',
    SKILL_MISMATCH: 'Qualifikationen passen nicht',
    COMPANY_CANCELLED: 'Vom Unternehmen abgesagt',
    PERFORMANCE: 'Leistungsbedenken',
    OTHER: 'Sonstiges',
  },
};

export function dropReasonLabel(reason: string, locale: Locale = 'en'): string {
  return LABELS[locale]?.[reason as DropReasonCode] ?? LABELS.en[reason as DropReasonCode] ?? reason;
}

export function dropReasonOptions(locale: Locale = 'en') {
  return DROP_REASONS.map((value) => ({
    value,
    label: dropReasonLabel(value, locale),
    requiresNote: value === 'OTHER',
  }));
}
