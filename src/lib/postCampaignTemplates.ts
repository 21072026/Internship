// The default texts of a postal campaign (#2697): the letter a new campaign
// starts from, the balancing-of-interests note, and the Art. 14 DSGVO notice
// printed on the back of every letter.
//
// The letter is per-organization DATA first (#2927): an organization that saved
// its own letter (the `postLetterTemplate` setting, written from the
// acquisition page) starts every new campaign from it — `resolveLetterBody()`.
// The built-in letters below are the fallback for an organization that has
// not; the MARKETING one is a short generic text about "unser Produkt".
//
// German on purpose, whatever the admin's UI language: the recipients are
// businesses in Germany, and the Art. 14 notice is a legal text addressed to
// them. The letter body is a starting point the admin edits; the notice is not
// editable per campaign — only its data-source line comes from the campaign.
//
// Not legal advice. Same review status as
// docs/marketing-vertical/outreach-compliance.md (Fachanwalt review pending);
// the notice follows docs/marketing/copy-bank.md § 9.2, adapted.

import type { VerticalKey } from '@/lib/verticals';
import type { OperatorIdentity } from '@/lib/imprint';
import { POST_COOLDOWN_DAYS } from '@/lib/postCampaignRule';

/** How long a prospect's address is kept without a reply, stated on the notice. */
export const PROSPECT_RETENTION_MONTHS = 24;

/** The bounds of a letter body — the campaign form's own (`campaignFields.letterBody`). */
export const LETTER_BODY_MIN = 20;
export const LETTER_BODY_MAX = 6000;

// The MARKETING fallback letter: deliberately generic. What a marketing
// tenant sells is its own business, so its real letter is its own data
// (`postLetterTemplate`); this text only gives a new campaign a sensible,
// editable shape with the same placeholders.
const MARKETING_BUILTIN_LETTER = `{salutation}

wir möchten {company} kurz unser Produkt vorstellen. Es nimmt Ihrem Team wiederkehrende Arbeit ab und bündelt, was heute auf mehrere Werkzeuge verteilt ist.

Gern zeigen wir Ihnen in einem kurzen Gespräch, wie das an Ihren eigenen Abläufen aussieht — unverbindlich und ohne Abo.

Wenn das für Sie interessant ist, finden Sie alles Weitere unter dem Link unten, oder Sie antworten formlos auf diesen Brief.

{link}

Mit freundlichen Grüßen`;

const INTERNCRM_LETTER = `{salutation}

Ihr Haus begleitet Praktikantinnen und Praktikanten, und ich vermute, dass die Betreuung dabei nicht am Werkzeug scheitert, sondern an der Dokumentation: wer wartet gerade auf wen, welcher Wochenbericht fehlt, welches Angebot ist herausgegangen und nie beantwortet worden.

Genau dafür gibt es InternCRM: eine Pipeline vom Erstkontakt bis zur Einstellung, Fristen je Stufe, Wochenberichte mit Freigabeschleife. Der Quellcode ist offen (AGPL-3.0); Sie können es auch auf einem eigenen Server betreiben.

Wenn das für Sie interessant ist, sehen Sie es sich unter dem Link unten an oder antworten Sie formlos auf diesen Brief.

{link}

Mit freundlichen Grüßen`;

/** The built-in letter of a vertical — the fallback of `resolveLetterBody()`. */
export function defaultLetterBody(vertical: VerticalKey): string {
  return vertical === 'MARKETING' ? MARKETING_BUILTIN_LETTER : INTERNCRM_LETTER;
}

/** Is this a letter body an organization may save as its own default? */
export function isStorableLetterBody(value: string): boolean {
  const text = value.trim();
  return text.length >= LETTER_BODY_MIN && text.length <= LETTER_BODY_MAX;
}

/**
 * The letter a new campaign starts from (#2927): the organization's own
 * (`postLetterTemplate`) when it saved one, the vertical's built-in letter
 * otherwise. A stored value outside the form's bounds — nothing writes one, but
 * a hand-edited row could — reads as unset rather than as a broken letter.
 */
export function resolveLetterBody(
  stored: string | null | undefined,
  vertical: VerticalKey,
): { letterBody: string; source: 'org' | 'builtin' } {
  const own = (stored ?? '').trim();
  return own && isStorableLetterBody(own)
    ? { letterBody: own, source: 'org' }
    : { letterBody: defaultLetterBody(vertical), source: 'builtin' };
}

/** The written balancing of interests (Art. 6 Abs. 1 lit. f) a campaign starts from. */
export function defaultBalancingNote(vertical: VerticalKey): string {
  const audience = vertical === 'MARKETING' ? 'die angeschriebenen Unternehmen' : 'Einrichtungen mit Praktikums- oder Mentoringprogrammen';
  return `Berechtigtes Interesse: Direktwerbung für ein Produkt, das für ${audience} fachlich einschlägig ist (ErwG 47 S. 7 DSGVO).
Verarbeitet werden nur Firmenname, Ansprechperson und Geschäftsanschrift aus öffentlich zugänglichen Quellen (Impressum nach § 5 DDG).
Interessen der Betroffenen: einmaliger Brief, keine elektronische Ansprache, keine Profilbildung; Art.-14-Hinweis und Widerspruchsrecht auf jedem Brief; Widerspruch führt zur dauerhaften Sperre; höchstens ein Brief je ${POST_COOLDOWN_DAYS} Tage.
Ergebnis: Die Interessen der Betroffenen überwiegen nicht.`;
}

/**
 * The Art. 14 notice for the back of the letter. `operator` is the controller
 * — the identity this deployment publishes for the world the campaign belongs
 * to (`operatorIdentity`, src/lib/imprint.ts). Returns paragraphs.
 */
export function art14Notice(input: { operator: OperatorIdentity | null; dataSource: string }): { title: string; paragraphs: [string, string][] } {
  const op = input.operator;
  const controller = op
    ? [op.name, op.address.join(', '), op.email].filter(Boolean).join(' · ')
    : 'Der Betreiber dieses Angebots (siehe Impressum).';
  const contact = op?.email ?? 'die im Impressum genannte Adresse';
  return {
    title: 'Informationen zur Verarbeitung Ihrer Daten (Art. 14 DSGVO)',
    paragraphs: [
      ['Verantwortlicher', controller + (op?.dpo ? ` · Datenschutzbeauftragte/r: ${op.dpo}` : '')],
      ['Verarbeitete Daten', 'Firmenname, Name der Ansprechperson (falls bekannt) und Geschäftsanschrift.'],
      ['Herkunft der Daten', input.dataSource.trim()],
      [
        'Zweck und Rechtsgrundlage',
        'Postalische Ansprache zu einem beruflich einschlägigen Angebot auf Grundlage von Art. 6 Abs. 1 lit. f DSGVO. Unser berechtigtes Interesse ist die Direktwerbung gegenüber Unternehmen, für deren Tätigkeit das Angebot fachlich einschlägig ist.',
      ],
      ['Empfänger', 'Keine Weitergabe an Dritte. Technische Dienstleister (Hosting) verarbeiten die Daten nur in unserem Auftrag.'],
      [
        'Speicherdauer',
        `Bis zu Ihrem Widerspruch, längstens ${PROSPECT_RETENTION_MONTHS} Monate nach dem letzten Kontakt. Nach einem Widerspruch speichern wir nur einen nicht umkehrbaren Prüfwert in einer Sperrliste, damit Sie keine weitere Werbung erhalten.`,
      ],
      [
        'Ihre Rechte',
        'Auskunft, Berichtigung, Löschung, Einschränkung der Verarbeitung, Datenübertragbarkeit sowie Beschwerde bei einer Datenschutz-Aufsichtsbehörde.',
      ],
      [
        'Widerspruchsrecht (Art. 21 Abs. 2 DSGVO)',
        `Sie können der Verarbeitung Ihrer Daten zu Zwecken der Direktwerbung jederzeit widersprechen; danach verarbeiten wir sie nicht mehr für diesen Zweck. Eine formlose Nachricht an ${contact} genügt.`,
      ],
    ],
  };
}
