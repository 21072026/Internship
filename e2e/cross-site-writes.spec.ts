import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #1467: the session cookie is SameSite=Lax, and every *.interncrm.com host is
// same-SITE with production — so a page on a sibling host (any topic env) got
// the admin's cookie attached to its POST. The handlers parse `text/plain` as
// JSON, and a `<form enctype="text/plain">` needs no preflight: one click minted
// an admin API key. The request context here carries the signed-in cookie, and
// the forged headers are exactly what that browser would have sent.
test('a same-site page cannot write with the admin cookie, and text/plain is refused (#1467)', async ({ page }) => {
  const adminEmail = uniqueEmail('csrf-admin');
  const pw = 'AdminPass123';
  await seedUser(adminEmail, pw, 'ADMIN', 'CSRF Admin');
  const stamp = Date.now();
  const names = [`csrf-same-site-${stamp}`, `csrf-plain-${stamp}`, `csrf-legit-${stamp}`, `csrf-machine-${stamp}`];

  try {
    await signInAndSettle(page, adminEmail, pw, '/admin');

    // 1. The form on a sibling host: same-site, its own Origin.
    const forged = await page.request.post('/api/admin/api-keys', {
      headers: { Origin: 'https://pr999.interncrm.com', 'Sec-Fetch-Site': 'same-site' },
      data: { name: names[0], scopes: ['candidates:read'] },
    });
    expect(forged.status()).toBe(403);
    expect((await forged.json()).code).toBe('cross_site_write');

    // 2. The enctype="text/plain" body with the `pad` trick — refused on its
    //    own, even claiming to be same-origin.
    const plain = await page.request.post('/api/admin/api-keys', {
      headers: { 'Content-Type': 'text/plain', 'Sec-Fetch-Site': 'same-origin' },
      data: `{"name":"${names[1]}","scopes":["candidates:read"],"pad":"="}`,
    });
    expect(plain.status()).toBe(415);
    expect((await plain.json()).code).toBe('unsupported_media_type');

    expect(await prisma.apiKey.count({ where: { name: { in: names.slice(0, 2) } } })).toBe(0);

    // 3. The real page still works: a fetch from our own origin is what every
    //    screen in the app sends.
    const status = await page.evaluate(async (name) => {
      const res = await fetch('/api/admin/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, scopes: ['candidates:read'] }),
      });
      return res.status;
    }, names[2]);
    expect(status).toBeLessThan(300);
    expect(await prisma.apiKey.count({ where: { name: names[2] } })).toBe(1);

    // 4. No browser headers at all is not a browser (webhook, cron, SCIM, the
    //    rest of this suite's request context): it reaches the handler as before.
    const machine = await page.request.post('/api/admin/api-keys', {
      data: { name: names[3], scopes: ['candidates:read'] },
    });
    expect(machine.status()).toBeLessThan(300);
  } finally {
    await prisma.apiKey.deleteMany({ where: { name: { in: names } } });
    await cleanupByEmail(adminEmail);
  }
});
