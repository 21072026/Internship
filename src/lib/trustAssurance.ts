import type { Locale } from '@/i18n/config';

/**
 * The "Assurance" block of the Trust Center (#2031) — one list, three locales.
 *
 * WHAT THIS IS
 *   The four assurance artefacts a security reviewer asks for, each with the
 *   one honest sentence that says what it contains: the vulnerability
 *   disclosure policy, the security-testing page (cadence + the OPEN findings),
 *   the pre-filled questionnaire answer library, and the SOC 2 decision. Plus
 *   the machine-readable contact at /.well-known/security.txt.
 *
 * WHERE IT RENDERS
 *   `src/components/trust/AssuranceSection.tsx`, which the /trust page (#2027)
 *   mounts. /trust is a server component built by that sibling task; this
 *   module and that component are deliberately self-contained so wiring them
 *   in is a single import, and so neither task has to edit the other's file.
 *
 * WHY THE COPY LIVES HERE AND NOT IN src/i18n/dictionaries.ts
 *   Same reason as `src/lib/newsletterContent.ts`: this is a *content list*,
 *   not scattered UI labels, and `Record<Locale, …>` makes TypeScript itself
 *   enforce EN/TR/DE parity — a missing German entry fails `tsc --noEmit`
 *   rather than only `npm run check:i18n`. Adding a link means writing three
 *   descriptions, which is the point.
 *
 * THE RULE FOR EDITING IT
 *   Every entry points at a document that exists in this repository, and no
 *   description may claim more than that document does. If an artefact is
 *   planned rather than published, it does not get an entry here — the trust
 *   page is the last place a hopeful sentence belongs.
 */

export interface AssuranceLink {
  key: string;
  /** Absolute URL (GitHub blob) or app-relative path. Must resolve today. */
  href: string;
  /** True for the served static file, so the page can render it as code. */
  monospace?: boolean;
  label: Record<Locale, string>;
  description: Record<Locale, string>;
}

const REPO_DOC = 'https://github.com/21072026/Internship/blob/main';

export const ASSURANCE_LINKS: AssuranceLink[] = [
  {
    key: 'vdp',
    href: `${REPO_DOC}/docs/trust/vulnerability-disclosure.md`,
    label: {
      en: 'Vulnerability disclosure policy',
      tr: 'Zafiyet bildirim politikası',
      de: 'Richtlinie zur Offenlegung von Schwachstellen',
    },
    description: {
      en: 'Which environments are in scope, what we ask a researcher not to do, our response targets, and the safe harbour for good-faith research. There is no bug bounty and we say so.',
      tr: 'Hangi ortamlar kapsamda, bir araştırmacıdan ne yapmamasını istiyoruz, yanıt sürelerimiz ve iyi niyetli araştırma için güvenli liman. Ödül programı yok ve bunu açıkça yazıyoruz.',
      de: 'Welche Umgebungen im Geltungsbereich liegen, worum wir Forschende bitten, unsere Reaktionszeiten und der Safe Harbour für gutgläubige Forschung. Es gibt kein Bug-Bounty — und wir sagen das.',
    },
  },
  {
    key: 'pentest',
    href: `${REPO_DOC}/docs/trust/pentest.md`,
    label: {
      en: 'Security testing and open findings',
      tr: 'Güvenlik testleri ve açık bulgular',
      de: 'Sicherheitstests und offene Feststellungen',
    },
    description: {
      en: 'No external penetration test has been commissioned yet. The page publishes the internal audit method instead, the areas proven correct, the areas nobody has examined, and the findings that are open right now.',
      tr: 'Henüz dış bir sızma testi yapılmadı. Sayfa bunun yerine iç denetim yöntemini, doğru çalıştığı kanıtlanmış alanları, hiç incelenmemiş alanları ve şu anda açık olan bulguları yayımlıyor.',
      de: 'Ein externer Penetrationstest wurde noch nicht beauftragt. Die Seite veröffentlicht stattdessen die interne Prüfmethode, die nachweislich korrekten Bereiche, die nie geprüften Bereiche und die aktuell offenen Feststellungen.',
    },
  },
  {
    key: 'questionnaire',
    href: `${REPO_DOC}/docs/trust/questionnaire-answers.md`,
    label: {
      en: 'Security questionnaire answers',
      tr: 'Güvenlik anketi cevapları',
      de: 'Antworten zum Sicherheitsfragebogen',
    },
    description: {
      en: 'The standard review questions, pre-answered, each with the file in this repository that proves it — and every "no" written as a no.',
      tr: 'Standart inceleme soruları önceden cevaplanmış; her cevabın yanında onu kanıtlayan dosya var ve her "hayır" hayır olarak yazılmış.',
      de: 'Die üblichen Prüffragen, vorab beantwortet, jeweils mit der Datei in diesem Repository, die es belegt — und jedes „Nein“ steht als Nein.',
    },
  },
  {
    key: 'soc2',
    href: `${REPO_DOC}/docs/trust/soc2-decision.md`,
    label: {
      en: 'SOC 2: the costed decision',
      tr: 'SOC 2: fiyatlandırılmış karar',
      de: 'SOC 2: die kalkulierte Entscheidung',
    },
    description: {
      en: 'There is no SOC 2 report and none is in progress. What it would cost, the prerequisites we do not meet, and the condition that would start it — in writing.',
      tr: 'SOC 2 raporu yok ve süreç başlatılmadı. Maliyeti, karşılamadığımız ön koşullar ve süreci başlatacak koşul — yazılı olarak.',
      de: 'Es gibt keinen SOC-2-Bericht und keinen laufenden Prozess. Was er kosten würde, welche Voraussetzungen wir nicht erfüllen und welche Bedingung ihn auslösen würde — schriftlich.',
    },
  },
  {
    key: 'securityTxt',
    href: '/.well-known/security.txt',
    monospace: true,
    label: {
      en: '/.well-known/security.txt',
      tr: '/.well-known/security.txt',
      de: '/.well-known/security.txt',
    },
    description: {
      en: 'The machine-readable security contact (RFC 9116), served by this deployment.',
      tr: 'Bu kurulumun sunduğu, makine tarafından okunabilir güvenlik iletişim kaydı (RFC 9116).',
      de: 'Der maschinenlesbare Sicherheitskontakt (RFC 9116), ausgeliefert von dieser Installation.',
    },
  },
];

export const ASSURANCE_HEADING: Record<Locale, { title: string; intro: string }> = {
  en: {
    title: 'Assurance',
    intro:
      'What backs the claims above, including the parts that are not finished. Every link below is a document you can read now — not a report you have to request.',
  },
  tr: {
    title: 'Güvence',
    intro:
      'Yukarıdaki iddiaların arkasında ne var — tamamlanmamış kısımlar dahil. Aşağıdaki her bağlantı, talep etmeniz gereken bir rapor değil, şimdi okuyabileceğiniz bir belge.',
  },
  de: {
    title: 'Nachweise',
    intro:
      'Was die Aussagen oben belegt — einschließlich der Punkte, die noch nicht fertig sind. Jeder Link unten führt zu einem Dokument, das Sie jetzt lesen können, nicht zu einem Bericht, den Sie anfordern müssen.',
  },
};
