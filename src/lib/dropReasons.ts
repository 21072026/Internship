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

export type DropReason = (typeof DROP_REASONS)[number];

const LABELS: Record<Locale, Record<DropReason, string>> = {
  tr: {
    CANDIDATE_WITHDREW: 'Aday çekildi',
    NO_RESPONSE: 'Yanıt alınamadı',
    ACCEPTED_ELSEWHERE: 'Başka bir teklifi kabul etti',
    SCHEDULE_CONFLICT: 'Takvim uyuşmazlığı',
    LOCATION: 'Konum',
    SKILL_MISMATCH: 'Beceri uyumsuzluğu',
    COMPANY_CANCELLED: 'Şirket iptal etti',
    PERFORMANCE: 'Performans',
    OTHER: 'Diğer',
  },
  en: {
    CANDIDATE_WITHDREW: 'Candidate withdrew',
    NO_RESPONSE: 'No response',
    ACCEPTED_ELSEWHERE: 'Accepted elsewhere',
    SCHEDULE_CONFLICT: 'Schedule conflict',
    LOCATION: 'Location',
    SKILL_MISMATCH: 'Skill mismatch',
    COMPANY_CANCELLED: 'Company cancelled',
    PERFORMANCE: 'Performance',
    OTHER: 'Other',
  },
  de: {
    CANDIDATE_WITHDREW: 'Bewerber zurückgezogen',
    NO_RESPONSE: 'Keine Antwort',
    ACCEPTED_ELSEWHERE: 'Anderes Angebot angenommen',
    SCHEDULE_CONFLICT: 'Terminkonflikt',
    LOCATION: 'Standort',
    SKILL_MISMATCH: 'Unpassende Qualifikationen',
    COMPANY_CANCELLED: 'Unternehmen hat abgesagt',
    PERFORMANCE: 'Leistung',
    OTHER: 'Sonstiges',
  },
};

export function dropReasonLabel(reason: string, locale: Locale = 'en'): string {
  return LABELS[locale]?.[reason as DropReason] ?? LABELS.en[reason as DropReason] ?? reason;
}

export function dropReasonOptions(locale: Locale = 'en') {
  return DROP_REASONS.map((value) => ({
    value,
    label: dropReasonLabel(value, locale),
    ...(value === 'OTHER' ? { requiresNote: true as const } : {}),
  }));
}
