// Single source of truth for the mentee pipeline stages (mirrors the Prisma
// PipelineStatus enum). Used by the API for validation and the UI for labels.
// Enum identifiers are English; display labels are Turkish (original spreadsheet).

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

// Turkish labels matching the original spreadsheet wording.
export const PIPELINE_LABELS: Record<PipelineStatus, string> = {
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
};

export const pipelineOptions = PIPELINE_STATUSES.map((value) => ({
  value,
  label: PIPELINE_LABELS[value],
}));

export function pipelineLabel(status: string): string {
  return PIPELINE_LABELS[status as PipelineStatus] ?? status;
}
