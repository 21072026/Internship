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
    CANDIDATE_WITHDREW: 'Aday süreçten çekildi',
    NO_RESPONSE: 'Ulaşılamadı',
    ACCEPTED_ELSEWHERE: 'Başka teklifi kabul etti',
    SCHEDULE_CONFLICT: 'Takvim uyuşmazlığı',
    LOCATION: 'Lokasyon uygun değil',
    SKILL_MISMATCH: 'Yetkinlik uyumsuzluğu',
    COMPANY_CANCELLED: 'Şirket tarafından iptal edildi',
    PERFORMANCE: 'Performans yetersizliği',
    OTHER: 'Diğer',
  },
  en: {
    CANDIDATE_WITHDREW: 'Candidate withdrew',
    NO_RESPONSE: 'No response',
    ACCEPTED_ELSEWHERE: 'Accepted elsewhere',
    SCHEDULE_CONFLICT: 'Schedule conflict',
    LOCATION: 'Location mismatch',
    SKILL_MISMATCH: 'Skill mismatch',
    COMPANY_CANCELLED: 'Company cancelled',
    PERFORMANCE: 'Insufficient performance',
    OTHER: 'Other',
  },
  de: {
    CANDIDATE_WITHDREW: 'Bewerbung zurückgezogen',
    NO_RESPONSE: 'Keine Antwort',
    ACCEPTED_ELSEWHERE: 'Anderes Angebot angenommen',
    SCHEDULE_CONFLICT: 'Terminkonflikt',
    LOCATION: 'Standort nicht passend',
    SKILL_MISMATCH: 'Unpassende Qualifikationen',
    COMPANY_CANCELLED: 'Unternehmen hat abgesagt',
    PERFORMANCE: 'Unzureichende Leistung',
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
