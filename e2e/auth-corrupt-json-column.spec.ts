import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Regression for #1150. Prisma JSON.parse()s a `Json` column when it reads the
// row, so a single invalid value made EVERY read of that row throw
// "Unexpected end of JSON input" — and because sign-in used to read the whole
// User row, the account became unreachable: no password would get in, and the
// login form showed the raw parser message. Sign-in now selects only the columns
// it uses (AUTH_USER_SELECT in src/lib/auth.ts), so a corrupt profile column
// can no longer cost anyone their access.
//
// Not tagged @smoke: whether the bad value can even be written depends on the
// engine. MySQL 8 (and any MariaDB column carrying Prisma's
// `CHECK (json_valid(...))`) rejects it at write time and the test skips itself;
// it runs on engines that accept it — which is exactly the shape production had.
// The invariant is additionally enforced without a database by
// `npm run check:auth-reads`, which runs on every CI build.
test('a corrupt Json column does not lock the user out of sign-in', async ({ page }) => {
  const email = uniqueEmail('corruptjson');
  const pw = 'CorruptJson123!';
  const user = await seedUser(email, pw, 'MENTEE', 'Corrupt Json User');

  let corrupted = false;
  try {
    try {
      await prisma.$executeRawUnsafe('UPDATE `User` SET `skills` = ? WHERE `id` = ?', '', user.id);
      corrupted = true;
    } catch {
      // The engine enforces valid JSON on write, so this row cannot be corrupted
      // here and there is nothing to regress against.
      test.skip(true, 'engine rejects invalid JSON on write (native JSON column or json_valid CHECK)');
    }

    // Sanity check: the value really is unreadable JSON, i.e. the hazard is real.
    const [{ ok }] = await prisma.$queryRawUnsafe<{ ok: number }[]>(
      'SELECT JSON_VALID(`skills`) AS ok FROM `User` WHERE `id` = ?',
      user.id
    );
    expect(Number(ok)).toBe(0);

    // The whole point: this user can still sign in.
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.startsWith('/auth'), { timeout: 20_000 });

    const session = await (await page.request.get('/api/auth/session')).json();
    expect(session?.user?.email).toBe(email);
  } finally {
    // Repair before cleanup: cleanupByEmail reads the row, which would itself
    // throw while the column is still corrupt.
    if (corrupted) {
      await prisma
        .$executeRawUnsafe('UPDATE `User` SET `skills` = ? WHERE `id` = ?', '[]', user.id)
        .catch(() => {});
    }
    await cleanupByEmail(email);
  }
});
