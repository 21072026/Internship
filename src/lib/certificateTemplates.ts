// Draft content for internship completion certificates & reference letters
// (#813). Client-safe (no Prisma) — mirrors the localized, code-owned catalog
// pattern already used for document templates (src/lib/templates.ts): a
// starter markdown-lite body (the same constrained subset renderTemplate.ts
// understands) that the admin/mentor previews and edits before generating a
// PDF. Not persisted anywhere until the server renders and stores it.

export type CertificateVariant = 'CERTIFICATE' | 'REFERENCE_LETTER';
export type CertLocale = 'en' | 'tr' | 'de';

export interface CertificateVars {
  menteeName: string;
  mentorName: string;
  companyName: string | null;
  startDate: string;
  endDate: string;
  duration: string;
  skills: string[];
}

const CERT_TITLE: Record<CertLocale, string> = {
  en: 'Internship Completion Certificate',
  tr: 'Staj Tamamlama Belgesi',
  de: 'Praktikumsbescheinigung',
};

const REF_TITLE: Record<CertLocale, string> = {
  en: 'Reference Letter',
  tr: 'Referans Mektubu',
  de: 'Referenzschreiben',
};

export function certificateTitle(variant: CertificateVariant, locale: CertLocale): string {
  return variant === 'CERTIFICATE' ? CERT_TITLE[locale] : REF_TITLE[locale];
}

function fmt(iso: string, locale: CertLocale): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(locale === 'en' ? 'en-GB' : locale, { year: 'numeric', month: 'long', day: 'numeric' });
}

// "3 months" / "3 ay" / "3 Monate" — whole-month duration between two dates,
// rounded down (matches how the internship period is described in prose).
export function formatDuration(startIso: string, endIso: string, locale: CertLocale): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '';
  let months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
  if (end.getDate() < start.getDate()) months -= 1;
  months = Math.max(0, months);
  if (locale === 'tr') return `${months} ay`;
  if (locale === 'de') return `${months} ${months === 1 ? 'Monat' : 'Monate'}`;
  return `${months} ${months === 1 ? 'month' : 'months'}`;
}

export function buildCertificateBody(v: CertificateVars, locale: CertLocale): string {
  const company = v.companyName;
  const skillsBlock = v.skills.length
    ? {
        en: `\n## Skills demonstrated\n${v.skills.map((s) => `- ${s}`).join('\n')}\n`,
        tr: `\n## Gösterilen beceriler\n${v.skills.map((s) => `- ${s}`).join('\n')}\n`,
        de: `\n## Gezeigte Fähigkeiten\n${v.skills.map((s) => `- ${s}`).join('\n')}\n`,
      }[locale]
    : '';

  if (locale === 'tr') {
    return `**${v.menteeName}**, ${fmt(v.startDate, locale)} – ${fmt(v.endDate, locale)} tarihleri arasında${company ? ` **${company}** bünyesinde` : ''} staj programını başarıyla tamamlamıştır.

Staj süresi: **${v.duration}**${skillsBlock}
Bu belge, yukarıda belirtilen stajın tamamlandığını onaylamak amacıyla düzenlenmiştir.`;
  }
  if (locale === 'de') {
    return `Wir bestätigen, dass **${v.menteeName}** vom ${fmt(v.startDate, locale)} bis zum ${fmt(v.endDate, locale)}${company ? ` ein Praktikum bei **${company}**` : ' ein Praktikum'} erfolgreich abgeschlossen hat.

Praktikumsdauer: **${v.duration}**${skillsBlock}
Diese Bescheinigung wird zur Bestätigung des oben genannten Praktikums ausgestellt.`;
  }
  return `This is to certify that **${v.menteeName}** has successfully completed an internship${company ? ` at **${company}**` : ''} from ${fmt(v.startDate, locale)} to ${fmt(v.endDate, locale)}.

Duration: **${v.duration}**${skillsBlock}
This certificate is issued to confirm the completion of the internship described above.`;
}

// A free-text starter the mentor is expected to rewrite in their own words
// (issue #813: "reference-letter varyantında mentor serbest metin
// düzenleyebilsin") — placeholders are already filled in so editing starts
// from a complete draft rather than blank tokens.
export function buildReferenceLetterBody(v: CertificateVars, locale: CertLocale): string {
  if (locale === 'tr') {
    return `**${v.menteeName}** ile ${fmt(v.startDate, locale)} – ${fmt(v.endDate, locale)} tarihleri arasında${v.companyName ? ` ${v.companyName} bünyesinde` : ''} birlikte çalışma fırsatım oldu.

Bu süre boyunca gösterdiği performansı ve katkılarını burada anlatabilirsiniz. [Bu paragrafı kendi gözlemlerinizle güncelleyin.]

Kendisini önümüzdeki adımlarında tereddütsüz tavsiye ederim.

${v.mentorName}`;
  }
  if (locale === 'de') {
    return `Ich hatte die Gelegenheit, vom ${fmt(v.startDate, locale)} bis zum ${fmt(v.endDate, locale)} mit **${v.menteeName}**${v.companyName ? ` bei ${v.companyName}` : ''} zusammenzuarbeiten.

Beschreiben Sie hier die Leistungen und den Beitrag während dieser Zeit. [Diesen Absatz mit eigenen Beobachtungen aktualisieren.]

Ich kann ${v.menteeName} für die nächsten Schritte uneingeschränkt empfehlen.

${v.mentorName}`;
  }
  return `I had the opportunity to work with **${v.menteeName}** from ${fmt(v.startDate, locale)} to ${fmt(v.endDate, locale)}${v.companyName ? ` at ${v.companyName}` : ''}.

Describe their performance and contributions during this time here. [Update this paragraph with your own observations.]

I recommend ${v.menteeName} without reservation for their next steps.

${v.mentorName}`;
}
