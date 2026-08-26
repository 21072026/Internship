import type { NewsletterIssueContent } from '@/lib/newsletter';

/**
 * The newsletter's HTML body (#1469).
 *
 * WHY THIS IS HAND-WRITTEN TABLE HTML AND NOT THE APP'S CSS
 *
 * Mail clients are not browsers. Outlook renders with Word's engine, Gmail
 * strips <style> from forwarded copies, and none of them support flexbox or
 * grid. So: tables for layout, inline styles for everything, no external CSS,
 * no web fonts, images that survive being blocked. The design language is the
 * product's (accent colour, rounded cards, generous spacing) but the mechanics
 * are 2003.
 *
 * The layout is built around *scanning*, because that is the only thing a
 * career-tips e-mail gets on a phone between two other tasks:
 *
 *   emoji + bold heading + one sentence, three to five times.
 *
 * Every element earns its place: a hidden preheader (otherwise the inbox
 * preview shows "View this email in your browser"), an optional hero image, one
 * tinted "ten minutes" box, one button, and a footer whose unsubscribe link is
 * a plain visible link rather than 6px grey text — a reader who cannot find it
 * presses the spam button instead, and that costs the sending domain.
 */

export interface NewsletterBrand {
  name: string;
  accent: string;
  logoUrl: string | null;
}

export interface NewsletterEmailLabels {
  /** e.g. "Career newsletter" — the small line above the title. */
  kicker: string;
  /** Heading of the tinted action box, e.g. "Ten minutes, today". */
  actionTitle: string;
  /** Heading of the mentor-only block. */
  mentorTitle: string;
  /** Footer: why am I getting this. `{brand}` is substituted. */
  footerWhy: string;
  archiveLink: string;
  preferencesLink: string;
  unsubscribeLink: string;
}

export interface NewsletterEmailOptions {
  content: NewsletterIssueContent;
  brand: NewsletterBrand;
  labels: NewsletterEmailLabels;
  /** Include the mentor-only block (see `showsMentorNote`). */
  withMentorNote: boolean;
  /**
   * The hero image's `src`. A `cid:` reference for a real send (an <img> pointing
   * at this app would need a session and render broken in every mail client);
   * an ordinary URL for the admin preview, which renders in a browser that has
   * one. Same renderer either way — a preview built by a second code path is a
   * preview of nothing.
   */
  imageSrc?: string | null;
  archiveUrl: string;
  preferencesUrl: string;
  /** Omitted only for the admin preview, which has no recipient to unsubscribe. */
  unsubscribeUrl?: string | null;
}

/**
 * Every interpolation below is escaped. The content is admin-authored rather
 * than public, but "our own admins would never" is not a security boundary:
 * one pasted `"` in a tip title breaks every following attribute, and the brand
 * fields are tenant-supplied (the same reasoning as `brandHeader` in
 * emailService).
 */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Author-typed newlines become paragraph breaks; nothing else is markup. */
function paragraph(value: string): string {
  return esc(value).replace(/\n{2,}/g, '<br><br>').replace(/\n/g, '<br>');
}

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const INK = '#1f2937';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';

/** A hex accent, or the product blue — never an unvalidated string in a style. */
function accentOf(brand: NewsletterBrand): string {
  return /^#[0-9a-fA-F]{3,8}$/.test(brand.accent) ? brand.accent : '#2563eb';
}

/**
 * The accent at ~8% over white, computed rather than hard-coded so a tenant's
 * own colour tints its own boxes. `rgba()` is unreliable in Outlook, so this
 * blends to an opaque hex.
 */
function tint(hex: string, ratio = 0.09): string {
  const full = hex.length === 4
    ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
    : hex.slice(0, 7);
  const n = parseInt(full.slice(1), 16);
  if (!Number.isFinite(n)) return '#eff6ff';
  const mix = (channel: number) => Math.round(255 - (255 - channel) * ratio);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

function tipRow(emoji: string, title: string, body: string): string {
  return `
        <tr>
          <td style="padding:0 0 18px 0;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
              <tr>
                <td width="34" valign="top" style="font-size:22px;line-height:26px;padding-right:10px;">${esc(emoji)}</td>
                <td valign="top">
                  <div style="font:600 16px/22px ${FONT};color:${INK};">${esc(title)}</div>
                  ${body ? `<div style="font:400 15px/23px ${FONT};color:${MUTED};padding-top:3px;">${paragraph(body)}</div>` : ''}
                </td>
              </tr>
            </table>
          </td>
        </tr>`;
}

export function renderNewsletterHtml(options: NewsletterEmailOptions): string {
  const { content, brand, labels, withMentorNote, imageSrc, archiveUrl, preferencesUrl, unsubscribeUrl } = options;
  const accent = accentOf(brand);
  const soft = tint(accent);

  const logo = brand.logoUrl
    ? `<img src="${esc(brand.logoUrl)}" alt="${esc(brand.name)}" width="120" style="max-height:34px;width:auto;border:0;display:block;">`
    : `<div style="font:700 15px/20px ${FONT};color:${accent};">${esc(brand.name)}</div>`;

  // A blocked hero image must not leave a hole where the intro should be, so it
  // carries no fixed height and an empty alt (decorative — never the message).
  const hero = imageSrc
    ? `<tr><td style="padding:0 0 24px 0;"><img src="${esc(imageSrc)}" alt="" width="552" style="width:100%;max-width:552px;height:auto;border:0;border-radius:12px;display:block;"></td></tr>`
    : '';

  const action = content.action
    ? `<tr><td style="padding:4px 0 8px 0;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${soft};border-radius:12px;">
              <tr><td style="padding:16px 18px;">
                <div style="font:600 13px/18px ${FONT};color:${accent};text-transform:uppercase;letter-spacing:.4px;">⚡ ${esc(labels.actionTitle)}</div>
                <div style="font:400 15px/23px ${FONT};color:${INK};padding-top:6px;">${paragraph(content.action)}</div>
              </td></tr>
            </table>
          </td></tr>`
    : '';

  // Mentors get the coaching angle on the same issue. Rendered as a bordered
  // aside rather than another tip so it reads as "this part is for you".
  const mentorNote = withMentorNote && content.mentorNote
    ? `<tr><td style="padding:12px 0 4px 0;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid ${LINE};border-radius:12px;">
              <tr><td style="padding:16px 18px;">
                <div style="font:600 13px/18px ${FONT};color:${MUTED};text-transform:uppercase;letter-spacing:.4px;">🎓 ${esc(labels.mentorTitle)}</div>
                <div style="font:400 15px/23px ${FONT};color:${INK};padding-top:6px;">${paragraph(content.mentorNote)}</div>
              </td></tr>
            </table>
          </td></tr>`
    : '';

  const cta = content.cta
    ? `<tr><td style="padding:22px 0 4px 0;">
            <a href="${esc(content.cta.url)}" style="display:inline-block;background:${accent};color:#ffffff;font:600 15px/20px ${FONT};text-decoration:none;padding:12px 22px;border-radius:10px;">${esc(content.cta.label)} →</a>
          </td></tr>`
    : '';

  const footerLinks = [
    `<a href="${esc(archiveUrl)}" style="color:${MUTED};text-decoration:underline;">${esc(labels.archiveLink)}</a>`,
    `<a href="${esc(preferencesUrl)}" style="color:${MUTED};text-decoration:underline;">${esc(labels.preferencesLink)}</a>`,
    // Last, and the same size as its neighbours: hiding it is what earns spam
    // reports.
    ...(unsubscribeUrl ? [`<a href="${esc(unsubscribeUrl)}" style="color:${MUTED};text-decoration:underline;">${esc(labels.unsubscribeLink)}</a>`] : []),
  ].join(' &nbsp;·&nbsp; ');

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
</head>
<body style="margin:0;padding:0;background:#f3f4f6;">
  <!-- Inbox preview line. Hidden in the body, shown next to the subject. -->
  <div style="display:none;font-size:1px;color:#f3f4f6;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${esc(content.preheader ?? content.intro)}</div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f3f4f6;">
    <tr><td align="center" style="padding:28px 12px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:100%;max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;">
        <tr><td style="height:4px;background:${accent};line-height:4px;font-size:0;">&nbsp;</td></tr>
        <tr><td style="padding:24px 24px 0 24px;">${logo}</td></tr>
        <tr><td style="padding:18px 24px 0 24px;">
          <div style="font:600 12px/16px ${FONT};color:${accent};text-transform:uppercase;letter-spacing:.6px;">${esc(labels.kicker)}</div>
          <h1 style="margin:8px 0 0 0;font:700 24px/31px ${FONT};color:${INK};">${esc(content.subject)}</h1>
        </td></tr>
        <tr><td style="padding:24px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            ${hero}
            <tr><td style="padding:0 0 22px 0;font:400 16px/25px ${FONT};color:${INK};">${paragraph(content.intro)}</td></tr>
            ${content.tips.map((tip) => tipRow(tip.emoji, tip.title, tip.body)).join('')}
            ${action}
            ${mentorNote}
            ${cta}
          </table>
        </td></tr>
        <tr><td style="padding:4px 24px 26px 24px;">
          <div style="border-top:1px solid ${LINE};padding-top:16px;font:400 12px/19px ${FONT};color:${MUTED};">
            ${esc(labels.footerWhy.replace('{brand}', brand.name))}<br>
            <span style="display:inline-block;padding-top:6px;">${footerLinks}</span>
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}
