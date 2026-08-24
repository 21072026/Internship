// Server-only PDF rendering for internship certificates & reference letters
// (#813). SEE docs/agent-experience.md for why this isn't the browser
// print/HTML pipeline the rest of the app uses (activityReport,
// TemplatesLibrary): those produce bytes only inside a user's browser tab,
// with nothing for the server to persist. A certificate must be stored as a
// Document row and be re-downloadable later through documentAccess — that
// needs real PDF bytes at generation time, not a print dialog.
//
// pdf-lib is pure JS/TS with zero native dependencies and never spawns a
// browser process, so it adds a few MB to node_modules and no Chromium/
// wkhtmltopdf binary to the Docker image, and carries none of headless
// Chromium's per-render memory footprint (OOM risk) — it draws primitives
// (text, lines, images) directly into a PDF byte stream in-process. The
// trade-off: it cannot lay out arbitrary HTML/CSS, so this module implements
// a small renderer for the same constrained markdown subset renderTemplate.ts
// already defines (#/##, **bold** headings only, "- " bullets, paragraphs).
// Inline bold within a paragraph/bullet is intentionally not supported — the
// on-screen preview (templateToHtml) still renders it correctly; only the
// final PDF strips ** markers rather than mixing fonts mid-line, which was
// judged not worth the added text-wrapping complexity for a short document.

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb, type RGB } from 'pdf-lib';
import { isHexColor, type ResolvedBranding } from './branding';
import { assertPublicHttpsUrl } from './ssrfGuard';

export interface CertificatePdfInput {
  title: string;
  bodyMarkdown: string;
  branding: ResolvedBranding;
  signatureName: string;
  signatureTitle: string;
  generatedAt: Date;
}

const PAGE_WIDTH = 841.89; // A4 landscape
const PAGE_HEIGHT = 595.28;
const MARGIN_X = 70;

function hexToRgb(hex: string | null): RGB | null {
  if (!hex || !isHexColor(hex)) return null;
  let h = hex.trim().slice(1);
  if (h.length === 3) h = h.split('').map((ch) => ch + ch).join('');
  return rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255);
}

async function tryEmbedImage(doc: PDFDocument, url: string) {
  try {
    let bytes: Uint8Array;
    if (url.startsWith('data:')) {
      const base64 = url.split(',')[1] ?? '';
      bytes = Buffer.from(base64, 'base64');
    } else if (/^https?:\/\//.test(url)) {
      // The logo URL is tenant-supplied (Organization.brandLogoUrl) but fetched
      // from the SERVER's network position, so it is the same hazard the webhook
      // sender guards against (#893): `http://169.254.169.254/…` reaches cloud
      // metadata and `http://127.0.0.1:3306` reaches the database, neither of
      // which the admin's own browser could touch. Nothing is echoed back here —
      // the bytes only ever become an embedded image — so an unguarded fetch is
      // a *blind* SSRF, still enough to probe internal services by timing and to
      // poke internal HTTP endpoints that act on a bare GET. Same allowlist as
      // the webhooks: https only, on a publicly-resolving address.
      const safe = await assertPublicHttpsUrl(url);
      const res = await fetch(safe, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return null;
      bytes = new Uint8Array(await res.arrayBuffer());
    } else {
      return null;
    }
    try {
      return await doc.embedPng(bytes);
    } catch {
      return await doc.embedJpg(bytes);
    }
  } catch {
    // Unreachable, blocked or unsupported logo — skip it rather than fail the
    // whole document. A certificate without the logo is still a valid
    // certificate; a 500 on download is not.
    return null;
  }
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function drawMarkdownBody(
  page: PDFPage,
  markdown: string,
  opts: { x: number; y: number; maxWidth: number; font: PDFFont; bold: PDFFont; size: number; lineHeight: number },
): number {
  let y = opts.y;
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      y -= opts.lineHeight * 0.5;
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const text = heading[2].replace(/\*\*/g, '');
      const size = heading[1].length === 1 ? opts.size + 3 : opts.size + 1;
      for (const wrapped of wrapText(text, opts.bold, size, opts.maxWidth)) {
        page.drawText(wrapped, { x: opts.x, y, size, font: opts.bold });
        y -= opts.lineHeight + 2;
      }
      continue;
    }
    const bullet = /^-\s+(.*)$/.exec(line);
    if (bullet) {
      const text = bullet[1].replace(/\*\*/g, '');
      const wrapped = wrapText(text, opts.font, opts.size, opts.maxWidth - 14);
      wrapped.forEach((wl, i) => {
        page.drawText(i === 0 ? `•  ${wl}` : wl, { x: opts.x + 14, y, size: opts.size, font: opts.font });
        y -= opts.lineHeight;
      });
      continue;
    }
    const text = line.replace(/\*\*/g, '');
    for (const wrapped of wrapText(text, opts.font, opts.size, opts.maxWidth)) {
      page.drawText(wrapped, { x: opts.x, y, size: opts.size, font: opts.font });
      y -= opts.lineHeight;
    }
  }
  return y;
}

export async function generateCertificatePdf(input: CertificatePdfInput): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const accent = hexToRgb(input.branding.color) ?? rgb(0.15, 0.23, 0.42);

  page.drawRectangle({
    x: 24, y: 24, width: PAGE_WIDTH - 48, height: PAGE_HEIGHT - 48,
    borderColor: accent, borderWidth: 3,
  });
  page.drawRectangle({
    x: 34, y: 34, width: PAGE_WIDTH - 68, height: PAGE_HEIGHT - 68,
    borderColor: accent, borderWidth: 0.75,
  });

  let y = PAGE_HEIGHT - 80;
  const maxWidth = PAGE_WIDTH - MARGIN_X * 2;

  if (input.branding.logoUrl) {
    const img = await tryEmbedImage(doc, input.branding.logoUrl);
    if (img) {
      const w = 90;
      const h = (img.height / img.width) * w;
      page.drawImage(img, { x: (PAGE_WIDTH - w) / 2, y: y - h + 20, width: w, height: h });
      y -= h + 10;
    }
  }

  const orgNameSize = 12;
  page.drawText(input.branding.name, {
    x: (PAGE_WIDTH - font.widthOfTextAtSize(input.branding.name, orgNameSize)) / 2,
    y, size: orgNameSize, font, color: rgb(0.4, 0.4, 0.4),
  });
  y -= 34;

  const titleSize = 22;
  page.drawText(input.title, {
    x: (PAGE_WIDTH - bold.widthOfTextAtSize(input.title, titleSize)) / 2,
    y, size: titleSize, font: bold, color: accent,
  });
  y -= 44;

  y = drawMarkdownBody(page, input.bodyMarkdown, {
    x: MARGIN_X, y, maxWidth, font, bold, size: 12, lineHeight: 17,
  });

  const sigY = Math.min(y - 30, 100);
  page.drawLine({ start: { x: MARGIN_X, y: sigY }, end: { x: MARGIN_X + 220, y: sigY }, thickness: 1, color: rgb(0.3, 0.3, 0.3) });
  page.drawText(input.signatureName, { x: MARGIN_X, y: sigY - 16, size: 11, font: bold });
  if (input.signatureTitle) {
    page.drawText(input.signatureTitle, { x: MARGIN_X, y: sigY - 30, size: 10, font, color: rgb(0.4, 0.4, 0.4) });
  }

  const dateStr = input.generatedAt.toISOString().slice(0, 10);
  page.drawText(dateStr, {
    x: PAGE_WIDTH - MARGIN_X - font.widthOfTextAtSize(dateStr, 10),
    y: sigY - 16, size: 10, font, color: rgb(0.4, 0.4, 0.4),
  });

  const bytes = await doc.save();
  return Buffer.from(bytes);
}
