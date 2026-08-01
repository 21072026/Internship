import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

/**
 * #888 — upload validation looked only at `file.type`, a client-written
 * multipart header. The bytes were never inspected, and the declared type is
 * stored and handed back on download, so a mislabelled file arrived on an
 * employer's machine wearing the word "CV".
 *
 * #890 — those downloads were served `inline` from our own origin with the
 * filename dropped into the header almost raw.
 */

const PASSWORD = 'UploadPass123';
const email = uniqueEmail('upload');
let userId = '';

const PDF_BYTES = Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n', 'latin1');

test.beforeAll(async () => {
  const u = await seedUser(email, PASSWORD, 'MENTEE', 'Upload Mentee');
  userId = u.id;
});

test.afterAll(async () => {
  await prisma.cvFile.deleteMany({ where: { userId } });
  await cleanupByEmail(email);
  await prisma.$disconnect();
});

test('a file whose bytes do not match its declared type is rejected', { tag: '@smoke' }, async ({ page }) => {
  await signInAndSettle(page, email, PASSWORD, '/portal');

  // An executable-ish payload announcing itself as a PDF.
  const disguised = await page.request.post('/api/cv', {
    multipart: {
      file: { name: 'cv.pdf', mimeType: 'application/pdf', buffer: Buffer.from('MZ\x90\x00not a pdf at all') },
    },
  });
  expect(disguised.status()).toBe(400);
  expect(await prisma.cvFile.findUnique({ where: { userId } })).toBeNull();

  // A real PDF still uploads.
  const genuine = await page.request.post('/api/cv', {
    multipart: { file: { name: 'cv.pdf', mimeType: 'application/pdf', buffer: PDF_BYTES } },
  });
  expect(genuine.status()).toBe(200);
});

test('a CV downloads as an attachment with a sanitised filename', { tag: '@smoke' }, async ({ page }) => {
  await signInAndSettle(page, email, PASSWORD, '/portal');
  // A name carrying a header-splitting sequence and a non-ASCII character.
  await page.request.post('/api/cv', {
    multipart: {
      file: { name: 'öz"geçmiş\r\nX-Injected: 1.pdf', mimeType: 'application/pdf', buffer: PDF_BYTES },
    },
  });

  const res = await page.request.get(`/api/cv/${userId}`);
  expect(res.status()).toBe(200);
  const headers = res.headers();
  expect(headers['content-disposition']).toContain('attachment');
  // The quote and the CRLF are gone; the header is one line.
  expect(headers['content-disposition']).not.toContain('"öz"');
  expect(headers['content-disposition']).not.toContain('\n');
  expect(headers['x-injected']).toBeUndefined();
  // Non-ASCII survives via RFC 5987 rather than being mangled.
  expect(headers['content-disposition']).toContain("filename*=UTF-8''");
  expect(headers['x-content-type-options']).toBe('nosniff');
});
