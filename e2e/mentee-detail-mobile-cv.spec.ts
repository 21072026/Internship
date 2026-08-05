import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';

/**
 * The mentee detail page on a phone, and the "view CV" link.
 *
 * Two regressions this locks down:
 *   - the header put the name/e-mail and the stage select in one row, so a long
 *     e-mail ran into the select and pushed the status badge off the screen;
 *   - since #890 the CV route answers `attachment` for everything, so "view CV"
 *     downloaded the file instead of showing it — a dead link on mobile.
 */

const password = 'CvPass123!';
// Enough of a PDF for the browser to recognise; the route only reads the bytes back.
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'utf8');

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a long e-mail does not break the mentee header, and the CV opens instead of downloading', async ({ page }) => {
  const mentorEmail = uniqueEmail('cvview-mentor');
  // The kind of address that broke the header.
  const menteeEmail = uniqueEmail('cvview-mentee-with-a-really-long-address-that-wraps');
  const mentor = await seedUser(mentorEmail, password, 'MENTOR', 'CvView Mentor');
  const mentee = await seedUser(menteeEmail, password, 'MENTEE', 'CvView Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });
  await prisma.cvFile.create({
    data: { userId: mentee.id, filename: 'cv.pdf', contentType: 'application/pdf', size: PDF.length, data: PDF },
  });
  await prisma.user.update({ where: { id: mentee.id }, data: { cvUrl: `/api/cv/${mentee.id}` } });

  try {
    await page.setViewportSize({ width: 375, height: 812 });
    await signInAndSettle(page, mentorEmail, password, '/mentor');
    await gotoSettled(page, `/mentor/mentees/${rel.id}`);

    // The header stacks: both the badge and the stage select are on screen and
    // the page does not scroll sideways.
    await expect(page.getByText(menteeEmail)).toBeVisible({ timeout: 15_000 });
    const stageSelect = page.getByLabel(/Pipeline/i);
    await expect(stageSelect).toBeVisible();

    // Nothing in the header sticks out past the right edge — that is what the
    // long e-mail used to cause (the status badge was clipped away).
    const viewport = page.viewportSize()!.width;
    for (const box of [
      await stageSelect.boundingBox(),
      await page.getByText(menteeEmail).boundingBox(),
    ]) {
      expect(box).not.toBeNull();
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport + 1);
    }
    const overflows = await page.evaluate(() => {
      const el = document.scrollingElement;
      return el ? el.scrollWidth - el.clientWidth : 999;
    });
    expect(overflows).toBeLessThanOrEqual(1);

    // "View CV" asks for the inline rendering, not a download.
    const cvLink = page.locator(`a[href*="/api/cv/${mentee.id}"]`).first();
    await expect(cvLink).toHaveAttribute('href', `/api/cv/${mentee.id}?inline=1`);

    // …and the route honours it for a PDF, while the bare URL still downloads.
    const inline = await page.request.get(`/api/cv/${mentee.id}?inline=1`);
    expect(inline.ok()).toBeTruthy();
    expect(inline.headers()['content-disposition']).toContain('inline');
    expect(inline.headers()['content-type']).toContain('application/pdf');

    const download = await page.request.get(`/api/cv/${mentee.id}`);
    expect(download.headers()['content-disposition']).toContain('attachment');
  } finally {
    await prisma.cvFile.deleteMany({ where: { userId: mentee.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
