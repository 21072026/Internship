import { createHash } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';
import { digestSourceText } from '../src/lib/profileDigestRule';
import { runProfileDigestSweep } from '../src/lib/profileDigest';

// The profile digest's own surface (#2038): a person reads exactly what is
// stored about them and asks for a new one; the route takes no id, so nobody
// reaches another person's digest. Without their AI_CV_PARSING consent nothing
// is generated (403 consent_required); with it but no AI available (CI has no
// provider key and the org no AI pack) the stored digest is kept untouched.
// The nightly sweep makes no call for an unchanged text and marks the row as
// checked, so the next night starts elsewhere.
test('own digest: read, refuse without consent, keep it when AI is unavailable; the sweep skips an unchanged text', async ({ playwright, baseURL }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const pw = 'DigestPass123!';
  const org = await prisma.organization.create({ data: { name: `Digest ${stamp}`, slug: `digest-${stamp}` } });
  const me = await playwright.request.newContext({ baseURL });
  const other = await playwright.request.newContext({ baseURL });
  try {
    const meEmail = uniqueEmail('digest-me');
    const otherEmail = uniqueEmail('digest-other');
    const mentee = await seedUser(meEmail, pw, 'MENTEE', 'Digest Mentee', org.id);
    await seedUser(otherEmail, pw, 'MENTEE', 'Other Mentee', org.id);
    const profile = { bio: 'Six years of QA, moving into backend work.', interests: 'backend, Go', targetPosition: 'Backend developer', skills: ['Testing'] };
    await prisma.user.update({ where: { id: mentee.id }, data: profile });
    const sourceHash = createHash('sha256').update(digestSourceText(profile)).digest('hex');

    expect((await signInViaApi(me, meEmail, pw)).ok).toBe(true);
    expect((await signInViaApi(other, otherEmail, pw)).ok).toBe(true);

    // Nothing yet.
    expect(await (await me.get('/api/profile/digest')).json()).toEqual({ available: true, digest: null });

    const stored = await prisma.profileDigest.create({
      data: { orgId: org.id, userId: mentee.id, digest: 'Moves from QA into backend.', themes: ['backend engineering', 'go'], sourceHash, model: 'test' },
    });
    const read = await (await me.get('/api/profile/digest')).json();
    expect(read.digest).toMatchObject({ digest: 'Moves from QA into backend.', themes: ['backend engineering', 'go'] });
    // Another person sees their own (none), never this one.
    expect((await (await other.get('/api/profile/digest')).json()).digest).toBeNull();

    // No consent: nothing is generated.
    const refused = await me.post('/api/profile/digest');
    expect(refused.status()).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'consent_required' });

    // Consent, but no AI available here: refused, and the stored digest stays.
    await prisma.userConsent.create({ data: { userId: mentee.id, type: 'AI_CV_PARSING', grantedAt: new Date() } });
    const unavailable = await me.post('/api/profile/digest');
    expect(unavailable.ok()).toBe(false);
    const body = await unavailable.json();
    expect(['not_entitled', 'not_configured', 'disabled']).toContain(body.code);
    expect(body.digest).toMatchObject({ digest: 'Moves from QA into backend.' });
    expect((await prisma.profileDigest.findUnique({ where: { userId: mentee.id } }))?.sourceHash).toBe(sourceHash);

    // The sweep: an unchanged text costs no call and the row is marked checked.
    await prisma.profileDigest.update({ where: { id: stored.id }, data: { updatedAt: new Date('2020-01-01T00:00:00Z') } });
    const counts = await runProfileDigestSweep();
    expect(counts.unchanged ?? 0).toBeGreaterThanOrEqual(1);
    const after = await prisma.profileDigest.findUnique({ where: { userId: mentee.id } });
    expect(after?.digest).toBe('Moves from QA into backend.');
    expect(after!.updatedAt.getTime()).toBeGreaterThan(new Date('2021-01-01').getTime());
  } finally {
    await me.dispose();
    await other.dispose();
    await prisma.user.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }
});
