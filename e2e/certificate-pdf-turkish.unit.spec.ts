import { test, expect } from '@playwright/test';
import { generateCertificatePdf } from '../src/lib/certificatePdf';
import type { ResolvedBranding } from '../src/lib/branding';

// The standard PDF fonts are WinAnsi and threw on ş/ğ/ı/İ ("WinAnsi cannot
// encode ı"), so a certificate for a Turkish name was a 500. Every drawn string
// now goes through pdfSafeText() (src/lib/pdfText.ts).
test('a certificate with Turkish letters in every field renders', { tag: '@smoke' }, async () => {
  const branding = { name: 'Örnek İş Programı', color: null, logoUrl: null } as unknown as ResolvedBranding;
  const pdf = await generateCertificatePdf({
    title: 'Staj Sertifikası',
    bodyMarkdown: '# Başarı\n\n**Ayşe Yağmur İnce** stajını başarıyla tamamladı.\n- Görev: Yazılım geliştirme',
    branding,
    signatureName: 'Şükrü Işık',
    signatureTitle: 'Mentör — Ğ',
    generatedAt: new Date('2026-10-29T00:00:00Z'),
  });
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
});
