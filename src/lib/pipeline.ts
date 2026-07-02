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
  de: {
    APPLICATION_100: '100 · Erstkontakt',
    APPROVAL_PENDING_220: '220 · Warte auf Freigabe',
    INTERVIEW_PENDING_250: '250 · Zu interviewen',
    INTRODUCTION_PENDING_270: '270 · Vorzustellen',
    INTERNSHIP_STARTING_300: '300 · Praktikum beginnt',
    INTERNSHIP_IN_PROGRESS_450: '450 · Praktikum läuft',
    INTERNSHIP_DROPPED_460: '460 · Praktikum abgebrochen',
    INTERNSHIP_COMPLETED_490: '490 · Praktikum abgeschlossen',
    JOB_SEEKING_500: '500 · Jobsuche',
    HIREABLE_600: '600 · Einstellbar',
    HIRED_660: '660 · Eingestellt',
    EMPLOYED_700: '700 · Beschäftigt',
    INTERNSHIP_FOUND_ELSEWHERE_800: '800 · Praktikum anderswo',
  },
};

export function pipelineLabel(status: string, locale: Locale = 'en'): string {
  return LABELS[locale]?.[status as PipelineStatus] ?? LABELS.en[status as PipelineStatus] ?? status;
}

export function pipelineOptions(locale: Locale = 'en') {
  return PIPELINE_STATUSES.map((value) => ({ value, label: pipelineLabel(value, locale) }));
}

// Logical groupings of the 13 stages, so the kanban board can collapse the
// horizontal sprawl into three phases: before the internship, during it, and
// the outcome. Every PipelineStatus belongs to exactly one group.
export type PipelineGroupKey = 'pre' | 'internship' | 'result';

export const PIPELINE_GROUPS: { key: PipelineGroupKey; statuses: PipelineStatus[] }[] = [
  {
    key: 'pre',
    statuses: ['APPLICATION_100', 'APPROVAL_PENDING_220', 'INTERVIEW_PENDING_250', 'INTRODUCTION_PENDING_270'],
  },
  {
    key: 'internship',
    statuses: ['INTERNSHIP_STARTING_300', 'INTERNSHIP_IN_PROGRESS_450', 'INTERNSHIP_DROPPED_460', 'INTERNSHIP_COMPLETED_490'],
  },
  {
    key: 'result',
    statuses: ['JOB_SEEKING_500', 'HIREABLE_600', 'HIRED_660', 'EMPLOYED_700', 'INTERNSHIP_FOUND_ELSEWHERE_800'],
  },
];

// Mentee-facing "what to do now" guidance per stage — turns the journey from a
// passive status display into actionable direction. Off-path statuses
// (dropped / found elsewhere) aren't included; the tracker shows a note instead.
const GUIDANCE: Record<Locale, Partial<Record<PipelineStatus, string>>> = {
  en: {
    APPLICATION_100: 'Your application is being reviewed. Make sure your profile, CV and skills are complete — a strong profile speeds this up.',
    APPROVAL_PENDING_220: 'Awaiting approval to move forward. No action needed yet — just keep your profile up to date and stay reachable.',
    INTERVIEW_PENDING_250: 'An interview is coming up. Confirm your availability with your mentor, and prepare using the Interview prep checklist template.',
    INTRODUCTION_PENDING_270: "You're about to be introduced to your mentor/company. Reply promptly to messages and meeting requests.",
    INTERNSHIP_STARTING_300: 'Your internship is about to start. Confirm the start date and logistics with your mentor.',
    INTERNSHIP_IN_PROGRESS_450: 'Log your progress regularly, ask questions through Q&A, and keep your skills list current.',
    INTERNSHIP_COMPLETED_490: 'Internship complete — update your CV and skills, and talk to your mentor about next steps.',
    JOB_SEEKING_500: "You're job-seeking. Keep your target position and skills current, and use the Cover letter / CV templates.",
    HIREABLE_600: "You're marked as hireable — stay in touch with your mentor and be ready for an offer conversation.",
    HIRED_660: 'Congratulations! Coordinate onboarding details (start date, paperwork) with the company.',
    EMPLOYED_700: "You've completed the journey — congratulations on finding a role!",
  },
  tr: {
    APPLICATION_100: 'Başvurun değerlendiriliyor. Profilinin, CV\'nin ve becerilerinin eksiksiz olduğundan emin ol — güçlü bir profil süreci hızlandırır.',
    APPROVAL_PENDING_220: 'İlerlemek için onay bekleniyor. Şimdilik yapman gereken bir şey yok — profilini güncel tut ve ulaşılabilir ol.',
    INTERVIEW_PENDING_250: 'Bir görüşme yaklaşıyor. Uygunluğunu mentörünle teyit et ve Mülakat hazırlık listesi şablonuyla hazırlan.',
    INTRODUCTION_PENDING_270: 'Mentörün/şirketinle tanıştırılmak üzeresin. Mesajlara ve toplantı taleplerine hızlı yanıt ver.',
    INTERNSHIP_STARTING_300: 'Stajın başlamak üzere. Başlangıç tarihini ve lojistiği mentörünle teyit et.',
    INTERNSHIP_IN_PROGRESS_450: 'İlerlemeni düzenli olarak kaydet, Soru-Cevap üzerinden sorular sor ve yetenek listeni güncel tut.',
    INTERNSHIP_COMPLETED_490: 'Staj tamamlandı — CV\'ni ve becerilerini güncelle, sonraki adımları mentörünle konuş.',
    JOB_SEEKING_500: 'İş arıyorsun. Hedef pozisyonunu ve becerilerini güncel tut, Ön yazı / CV şablonlarını kullan.',
    HIREABLE_600: 'İşe alınabilir olarak işaretlendin — mentörünle iletişimde kal ve bir teklif görüşmesine hazır ol.',
    HIRED_660: 'Tebrikler! İşe başlama detaylarını (tarih, evraklar) şirketle koordine et.',
    EMPLOYED_700: 'Yolculuğunu tamamladın — bir iş bulduğun için tebrikler!',
  },
  de: {
    APPLICATION_100: 'Deine Bewerbung wird geprüft. Stelle sicher, dass dein Profil, Lebenslauf und deine Fähigkeiten vollständig sind — ein starkes Profil beschleunigt das.',
    APPROVAL_PENDING_220: 'Warten auf Freigabe. Momentan ist nichts zu tun — halte dein Profil aktuell und bleib erreichbar.',
    INTERVIEW_PENDING_250: 'Ein Interview steht bevor. Bestätige deine Verfügbarkeit bei deinem Mentor und bereite dich mit der Interview-Vorbereitungs-Checkliste vor.',
    INTRODUCTION_PENDING_270: 'Du wirst deinem Mentor/Unternehmen bald vorgestellt. Antworte zügig auf Nachrichten und Terminanfragen.',
    INTERNSHIP_STARTING_300: 'Dein Praktikum beginnt bald. Bestätige Starttermin und Logistik mit deinem Mentor.',
    INTERNSHIP_IN_PROGRESS_450: 'Halte deinen Fortschritt regelmäßig fest, stelle Fragen über Q&A und halte deine Fähigkeitenliste aktuell.',
    INTERNSHIP_COMPLETED_490: 'Praktikum abgeschlossen — aktualisiere Lebenslauf und Fähigkeiten und besprich die nächsten Schritte mit deinem Mentor.',
    JOB_SEEKING_500: 'Du suchst einen Job. Halte Zielposition und Fähigkeiten aktuell und nutze die Anschreiben-/Lebenslauf-Vorlagen.',
    HIREABLE_600: 'Du bist als einstellbar markiert — bleib mit deinem Mentor in Kontakt und sei bereit für ein Angebotsgespräch.',
    HIRED_660: 'Herzlichen Glückwunsch! Kläre die Einstiegsdetails (Starttermin, Unterlagen) mit dem Unternehmen.',
    EMPLOYED_700: 'Du hast die Reise abgeschlossen — herzlichen Glückwunsch zu deiner neuen Stelle!',
  },
};

export function pipelineGuidance(status: string, locale: Locale = 'en'): string | null {
  return GUIDANCE[locale]?.[status as PipelineStatus] ?? GUIDANCE.en[status as PipelineStatus] ?? null;
}
