// Single source of truth for the mentee pipeline stages (mirrors the Prisma
// PipelineStatus enum). Enum identifiers are English; display labels are
// localized (EN/TR).
import type { Locale } from '@/i18n/config';

export const PIPELINE_STATUSES = [
  'APPLICATION_100',
  'APPROVAL_PENDING_220',
  'INTERVIEW_PENDING_250',
  'INTRODUCTION_PENDING_270',
  'INTERNSHIP_STARTING_300',
  'INTERNSHIP_IN_PROGRESS_450',
  'INTERNSHIP_DROPPED_460',
  'INTERNSHIP_COMPLETED_490',
  'JOB_SEEKING_500',
  'HIREABLE_600',
  'HIRED_660',
  'EMPLOYED_700',
  'INTERNSHIP_FOUND_ELSEWHERE_800',
] as const;

export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

const LABELS: Record<Locale, Record<PipelineStatus, string>> = {
  tr: {
    APPLICATION_100: '100 · İlk temas',
    APPROVAL_PENDING_220: '220 · Onay bekliyor',
    INTERVIEW_PENDING_250: '250 · Görüşülecek',
    INTRODUCTION_PENDING_270: '270 · Tanıştırılacak',
    INTERNSHIP_STARTING_300: '300 · Staj başlayacak',
    INTERNSHIP_IN_PROGRESS_450: '450 · Staj devam ediyor',
    INTERNSHIP_DROPPED_460: '460 · Staj yarım bıraktı',
    INTERNSHIP_COMPLETED_490: '490 · Staj bitti',
    JOB_SEEKING_500: '500 · İş arıyor',
    HIREABLE_600: '600 · İşe alınabilir',
    HIRED_660: '660 · İşe alındı',
    EMPLOYED_700: '700 · İş buldu',
    INTERNSHIP_FOUND_ELSEWHERE_800: '800 · Başka yerde staj buldu',
  },
  en: {
    APPLICATION_100: '100 · First contact',
    APPROVAL_PENDING_220: '220 · Awaiting approval',
    INTERVIEW_PENDING_250: '250 · To interview',
    INTRODUCTION_PENDING_270: '270 · To introduce',
    INTERNSHIP_STARTING_300: '300 · Internship starting',
    INTERNSHIP_IN_PROGRESS_450: '450 · Internship in progress',
    INTERNSHIP_DROPPED_460: '460 · Internship dropped',
    INTERNSHIP_COMPLETED_490: '490 · Internship completed',
    JOB_SEEKING_500: '500 · Job seeking',
    HIREABLE_600: '600 · Hireable',
    HIRED_660: '660 · Hired',
    EMPLOYED_700: '700 · Employed',
    INTERNSHIP_FOUND_ELSEWHERE_800: '800 · Internship elsewhere',
  },
};

export function pipelineLabel(status: string, locale: Locale = 'en'): string {
  return LABELS[locale]?.[status as PipelineStatus] ?? LABELS.en[status as PipelineStatus] ?? status;
}

export function pipelineOptions(locale: Locale = 'en') {
  return PIPELINE_STATUSES.map((value) => ({ value, label: pipelineLabel(value, locale) }));
}
