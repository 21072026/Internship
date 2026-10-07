// Ready-made "next step" lines for the follow-up panel (#2875).
//
// The follow-up note on a record (#2563) is one short line the owner writes:
// "ask for the updated CV", "confirm the start date with the company". The
// panel used to offer a sales example as its placeholder — "call about
// pricing" — which is what a MARKETING rep writes and what a mentor never
// does. This module is the internship answer: for each canonical pipeline
// stage, the two or three lines mentors actually write at that point, so the
// first one can be the placeholder and all of them can be one-click chips.
//
// Three rules:
//   • Keyed on the CANONICAL stage keys (src/lib/pipeline.ts). A tenant with a
//     renamed pipeline keeps the keys, so it keeps the chips; a vertical with
//     its own funnel (MARKETING) has no entry here and gets no chips — its rep
//     writes "call about pricing" by hand, as before, and the placeholder for
//     that vertical lives in src/i18n/verticalOverlays.ts.
//   • Per locale, typed on `Locale` so a missing language does not compile.
//     The texts live here rather than in the dictionary because they are a
//     catalogue keyed on stage keys, like the stage labels in pipeline.ts,
//     and because the dictionary's MARKETING leak ratchet (#2558) would count
//     every "mentee" in them although a MARKETING screen never renders them.
//   • Every line fits the note column (NEXT_ACTION_NOTE_MAX, 280 chars) with
//     room to spare — a chip is a starting point the owner edits, not a
//     paragraph. The unit test pins this.
//
// Dependency-free on purpose (type-only imports), so
// scripts/test/next-step-suggestions.test.mjs can load it under plain
// `node --experimental-strip-types`.

import type { Locale } from '@/i18n/config';
import type { PipelineStatus } from '@/lib/pipeline';

type Catalogue = Record<Locale, Partial<Record<PipelineStatus, readonly string[]>>>;

/**
 * The longest line a chip carries — the catalogue's lines and the AI's
 * proposals alike (src/lib/aiNextStep.ts cuts to it). Well inside the note
 * column's 280 chars: a chip is a starting point, not a paragraph.
 */
export const NEXT_STEP_LINE_MAX = 120;

export const NEXT_STEP_SUGGESTIONS: Catalogue = {
  tr: {
    APPLICATION_100: ['Tanışma görüşmesi için gün öner', 'CV ve profilini tamamlamasını iste', 'Hedef pozisyonunu ve ilgi alanlarını öğren'],
    APPROVAL_PENDING_220: ['Yöneticiden onay durumunu sor', 'Eksik belgeleri hatırlat', 'Onay sonrası ilk adımı planla'],
    INTERVIEW_PENDING_250: ['Görüşme tarihini netleştir', 'Örnek görüşme sorularını birlikte çalış', 'Görüşme sonrası geri bildirim al'],
    INTRODUCTION_PENDING_270: ['Uygun şirketi belirle ve tanıştırma e-postasını gönder', 'CV’nin son hâlini şirkete ilet', 'Şirketten dönüş gelmediyse nazikçe hatırlat'],
    INTERNSHIP_STARTING_300: ['Başlangıç tarihini şirketle teyit et', 'İlk hafta beklentilerini konuş', 'Sözleşme ve evrakların tamamlandığını kontrol et'],
    INTERNSHIP_IN_PROGRESS_450: ['Haftalık raporu birlikte gözden geçir', 'Şirket yetkilisinden ara geri bildirim al', 'Staj hedeflerinin durumunu konuş'],
    INTERNSHIP_DROPPED_460: ['Bırakma nedenini konuş ve not al', 'Yeni bir yol haritası için görüşme planla', 'Uygun olursa yeniden eşleştirme öner'],
    INTERNSHIP_COMPLETED_490: ['Staj değerlendirmesini ve referans mektubunu iste', 'CV’ye staj deneyimini eklemesini sağla', 'Sonraki hedefi (iş / yeni staj) belirle'],
    JOB_SEEKING_500: ['Başvuru listesini birlikte çıkar', 'LinkedIn profilini gözden geçir', 'Haftalık başvuru hedefi koy ve takip et'],
    HIREABLE_600: ['Açık pozisyonlarla eşleştir ve ilet', 'Mülakat provası planla', 'Referansları hazır tut'],
    HIRED_660: ['İşe başlangıç tarihini teyit et', 'İlk ay için kısa bir kontrol görüşmesi planla', 'Programa geri bildirim yazmasını iste'],
    EMPLOYED_700: ['Üç ay sonra nasıl gittiğini sor', 'Mentor olarak programa katılmayı öner', 'Başarı hikâyesini paylaşmak için izin iste'],
    INTERNSHIP_FOUND_ELSEWHERE_800: ['Nerede başladığını ve ne yaptığını öğren', 'Eşleşmenin kapatılmasını teyit et', 'İlerleyen dönemde iletişimde kalmayı öner'],
  },
  en: {
    APPLICATION_100: ['Propose a day for the intro call', 'Ask them to complete the CV and profile', 'Learn their target role and interests'],
    APPROVAL_PENDING_220: ['Ask the admin where the approval stands', 'Remind them of the missing documents', 'Plan the first step after approval'],
    INTERVIEW_PENDING_250: ['Pin down the interview date', 'Work through sample interview questions together', 'Collect feedback after the interview'],
    INTRODUCTION_PENDING_270: ['Pick the right company and send the intro e-mail', 'Forward the final CV to the company', 'Nudge the company if there is no reply yet'],
    INTERNSHIP_STARTING_300: ['Confirm the start date with the company', 'Talk through first-week expectations', 'Check the contract and paperwork are complete'],
    INTERNSHIP_IN_PROGRESS_450: ['Go through the weekly report together', 'Get mid-term feedback from the company contact', 'Review where the internship goals stand'],
    INTERNSHIP_DROPPED_460: ['Talk through why it stopped and note it', 'Schedule a call for a new plan', 'Suggest a re-match if it fits'],
    INTERNSHIP_COMPLETED_490: ['Ask for the evaluation and the reference letter', 'Make sure the internship is on the CV', 'Set the next goal (a job or another internship)'],
    JOB_SEEKING_500: ['Draw up the application list together', 'Review the LinkedIn profile', 'Set a weekly application target and follow it'],
    HIREABLE_600: ['Match with open positions and forward them', 'Schedule a mock interview', 'Have the references ready'],
    HIRED_660: ['Confirm the start date', 'Plan a short check-in for the first month', 'Ask them to write feedback for the programme'],
    EMPLOYED_700: ['Ask how it is going after three months', 'Suggest joining the programme as a mentor', 'Ask for permission to share the success story'],
    INTERNSHIP_FOUND_ELSEWHERE_800: ['Learn where they started and what they do', 'Confirm the pairing is closed', 'Offer to stay in touch later on'],
  },
  de: {
    APPLICATION_100: ['Termin für das Kennenlerngespräch vorschlagen', 'Um Lebenslauf und vollständiges Profil bitten', 'Zielposition und Interessen erfragen'],
    APPROVAL_PENDING_220: ['Beim Admin nach dem Stand der Freigabe fragen', 'An fehlende Unterlagen erinnern', 'Ersten Schritt nach der Freigabe planen'],
    INTERVIEW_PENDING_250: ['Gesprächstermin festlegen', 'Beispielfragen fürs Gespräch gemeinsam üben', 'Nach dem Gespräch Feedback einholen'],
    INTRODUCTION_PENDING_270: ['Passendes Unternehmen auswählen und Vorstellungs-Mail senden', 'Aktuellen Lebenslauf an das Unternehmen weiterleiten', 'Beim Unternehmen nachfassen, falls keine Antwort kam'],
    INTERNSHIP_STARTING_300: ['Starttermin mit dem Unternehmen bestätigen', 'Erwartungen an die erste Woche besprechen', 'Vertrag und Unterlagen auf Vollständigkeit prüfen'],
    INTERNSHIP_IN_PROGRESS_450: ['Wochenbericht gemeinsam durchgehen', 'Zwischenfeedback vom Unternehmen einholen', 'Stand der Praktikumsziele besprechen'],
    INTERNSHIP_DROPPED_460: ['Abbruchgrund besprechen und festhalten', 'Gespräch für einen neuen Plan vereinbaren', 'Bei Bedarf eine neue Zuordnung vorschlagen'],
    INTERNSHIP_COMPLETED_490: ['Beurteilung und Praktikumszeugnis anfordern', 'Praktikum in den Lebenslauf aufnehmen lassen', 'Nächstes Ziel festlegen (Job oder weiteres Praktikum)'],
    JOB_SEEKING_500: ['Bewerbungsliste gemeinsam erstellen', 'LinkedIn-Profil durchsehen', 'Wöchentliches Bewerbungsziel setzen und verfolgen'],
    HIREABLE_600: ['Mit offenen Stellen abgleichen und weiterleiten', 'Probe-Interview planen', 'Referenzen bereithalten'],
    HIRED_660: ['Starttermin bestätigen', 'Kurzes Check-in für den ersten Monat planen', 'Um Feedback für das Programm bitten'],
    EMPLOYED_700: ['Nach drei Monaten nachfragen, wie es läuft', 'Teilnahme als Mentor im Programm vorschlagen', 'Um Erlaubnis bitten, die Erfolgsgeschichte zu teilen'],
    INTERNSHIP_FOUND_ELSEWHERE_800: ['Erfahren, wo es losging und was die Aufgaben sind', 'Abschluss der Zuordnung bestätigen', 'Anbieten, später in Kontakt zu bleiben'],
  },
};

/**
 * The lines for a stage in a locale; empty for an unknown stage key, a
 * vertical with its own funnel, or a locale the catalogue does not carry.
 */
export function nextStepSuggestions(locale: string, pipelineStatus: string | null | undefined): readonly string[] {
  if (!pipelineStatus) return [];
  const byStage = NEXT_STEP_SUGGESTIONS[locale as Locale];
  if (!byStage) return [];
  return byStage[pipelineStatus as PipelineStatus] ?? [];
}
