// The offer letter as a branded A4 PDF (#1857), on certificatePdf.ts's
// branding helpers (accent colour, SSRF-guarded logo, word wrap). Unlike a
// certificate a letter can run past one page, so this renderer paginates.
// Every string goes through pdfSafeText(): the standard fonts are WinAnsi and
// a Turkish name must never turn a download into a 500.
//
// The PDF is rendered on request from the frozen snapshot, never stored: the
// snapshot IS the record, and the bytes are reproducible from it. (A stored
// copy would be one more DB blob per offer — see Document.data.)

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { ResolvedBranding } from './branding';
import { hexToRgb, tryEmbedImage, wrapText } from './certificatePdf';
import { pdfSafeText } from './offerLetter';

const PAGE_WIDTH = 595.28; // A4 portrait
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 64;
const TOP = PAGE_HEIGHT - 72;
const BOTTOM = 80;

export interface OfferLetterPdfInput {
  bodyMarkdown: string;
  branding: ResolvedBranding;
  /** Printed in the footer of every page, e.g. "Click-to-accept record — not a qualified electronic signature". */
  footer: string;
}

export async function generateOfferLetterPdf(input: OfferLetterPdfInput): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const accent = hexToRgb(input.branding.color) ?? rgb(0.15, 0.23, 0.42);
  const maxWidth = PAGE_WIDTH - MARGIN_X * 2;
  const logo = input.branding.logoUrl ? await tryEmbedImage(doc, input.branding.logoUrl) : null;

  let page: PDFPage = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = TOP;
  const startPage = (first: boolean) => {
    page.drawRectangle({ x: 0, y: PAGE_HEIGHT - 8, width: PAGE_WIDTH, height: 8, color: accent });
    const footer = pdfSafeText(input.footer);
    page.drawText(footer, { x: MARGIN_X, y: 40, size: 8, font, color: rgb(0.45, 0.45, 0.45) });
    y = TOP;
    if (!first) return;
    if (logo) {
      const w = 80;
      const h = (logo.height / logo.width) * w;
      page.drawImage(logo, { x: MARGIN_X, y: y - h + 12, width: w, height: h });
      y -= h + 4;
    }
    page.drawText(pdfSafeText(input.branding.name), { x: MARGIN_X, y, size: 11, font: bold, color: accent });
    y -= 36;
  };
  startPage(true);

  const line = (text: string, f: PDFFont, size: number, lineHeight: number, x = MARGIN_X) => {
    if (y < BOTTOM) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      startPage(false);
    }
    page.drawText(text, { x, y, size, font: f, color: f === bold ? accent : rgb(0.1, 0.1, 0.1) });
    y -= lineHeight;
  };

  for (const raw of pdfSafeText(input.bodyMarkdown).replace(/\r\n/g, '\n').split('\n')) {
    const text = raw.trim();
    if (!text) {
      y -= 7;
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(text);
    if (heading) {
      const size = heading[1].length === 1 ? 17 : 13;
      y -= 4;
      for (const w of wrapText(heading[2].replace(/\*\*/g, ''), bold, size, maxWidth)) line(w, bold, size, size + 6);
      continue;
    }
    const bullet = /^-\s+(.*)$/.exec(text);
    if (bullet) {
      wrapText(bullet[1].replace(/\*\*/g, ''), font, 11, maxWidth - 14).forEach((w, i) =>
        line(i === 0 ? `•  ${w}` : w, font, 11, 16, MARGIN_X + (i === 0 ? 4 : 18)),
      );
      continue;
    }
    for (const w of wrapText(text.replace(/\*\*/g, ''), font, 11, maxWidth)) line(w, font, 11, 16);
  }

  return Buffer.from(await doc.save());
}
