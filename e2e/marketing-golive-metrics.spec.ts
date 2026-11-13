import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInViaApi, gotoSettled, asHost, MARKETING_HOST } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '@/lib/programTemplates';

/**
 * The go-live week numbers on the funnel card (#2578): the median time to first
 * contact and the share of live trials with an end date. Two MARKETING orgs of
 * synthetic data; the second one's rows must not reach the first one's numbers.
 *
 * Org A, all inside the last three days:
 *   R1  came from a demo request 48h ago; created 40h ago; first log 46h ago
 *       → 2h, measured from the REQUEST (from the record it would be negative)
 *   R2  no request; created 30h ago; first log 24h ago → 6h; a live trial WITH an end date
 *   R3  no request; created 20h ago; logs 10h and 5h ago → 10h (the first one);
 *       a live trial WITHOUT an end date
 *   R4  no request; created 10h ago; no log → waiting
 *   median(2, 6, 10) = 6h · trials 1 of 2 = 50%
 *
 * Org B: a record contacted after 100h and a live trial with no end date —
 * either would move A's numbers if it leaked in.
 *
 * And an INTERNSHIP org's funnel payload does not carry the keys at all.
 */

const PW = 'GoLive123!';
const H = 60 * 60 * 1000;
const ago = (hours: number) => new Date(Date.now() - hours * H);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

test('the go-live boxes: median first contact from the request, trial end-date coverage, per org', async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const template = defaultTemplateForVertical('MARKETING')!;
  const mkOrg = async (tag: string, vertical: 'MARKETING' | 'INTERNSHIP') => {
    const org = await prisma.organization.create({ data: { name: `GoLive ${tag} ${stamp}`, slug: `golive-${tag}-${stamp}`, vertical } });
    if (vertical === 'MARKETING') {
      await prisma.pipelineStage.createMany({ data: templateStagePayload(template).stages.map((s) => ({ ...s, orgId: org.id })) });
    }
    return org;
  };
  const orgA = await mkOrg('a', 'MARKETING');
  const orgB = await mkOrg('b', 'MARKETING');
  const orgI = await mkOrg('i', 'INTERNSHIP');
  const emails: string[] = [];
  const person = async (tag: string, role: 'ADMIN' | 'MENTOR' | 'MENTEE', orgId: string) => {
    const email = uniqueEmail(`golive-${tag}`);
    emails.push(email);
    return seedUser(email, PW, role, `GoLive ${tag}`, orgId);
  };

  try {
    const adminA = await person('admin-a', 'ADMIN', orgA.id);
    const ownerA = await person('owner-a', 'MENTOR', orgA.id);
    const ownerB = await person('owner-b', 'MENTOR', orgB.id);
    const adminI = await person('admin-i', 'ADMIN', orgI.id);

    const record = async (
      orgId: string,
      ownerId: string,
      tag: string,
      opts: { startedHoursAgo: number; requestHoursAgo?: number; logsHoursAgo?: number[]; trial?: { endsAt: Date | null } },
    ) => {
      const lead = await person(`lead-${tag}`, 'MENTEE', orgId);
      const company = await prisma.company.create({ data: { name: `GoLive account ${tag} ${stamp}`, orgId } });
      if (opts.requestHoursAgo != null) {
        await prisma.companyInquiry.create({
          data: {
            orgId,
            companyName: company.name,
            contactName: 'Synthetic Contact',
            email: `golive-${tag}-${stamp}@example.test`,
            createdAt: ago(opts.requestHoursAgo),
            convertedCompanyId: company.id,
            convertedAt: ago(opts.startedHoursAgo),
          },
        });
      }
      const rel = await prisma.mentorshipRelation.create({
        data: {
          orgId,
          mentorId: ownerId,
          menteeId: lead.id,
          companyId: company.id,
          startDate: ago(opts.startedHoursAgo),
          pipelineStatus: opts.trial ? 'TRIAL_ACTIVE' : 'LEAD_NEW',
          ...(opts.trial ? { trialStartedAt: ago(opts.startedHoursAgo), trialEndsAt: opts.trial.endsAt } : {}),
        },
      });
      for (const h of opts.logsHoursAgo ?? []) {
        await prisma.interactionLog.create({ data: { relationId: rel.id, date: ago(h), type: 'Call', notes: 'synthetic' } });
      }
      return rel;
    };

    await record(orgA.id, ownerA.id, 'r1', { requestHoursAgo: 48, startedHoursAgo: 40, logsHoursAgo: [46] });
    await record(orgA.id, ownerA.id, 'r2', { startedHoursAgo: 30, logsHoursAgo: [24], trial: { endsAt: new Date(Date.now() + 14 * 24 * H) } });
    await record(orgA.id, ownerA.id, 'r3', { startedHoursAgo: 20, logsHoursAgo: [10, 5], trial: { endsAt: null } });
    await record(orgA.id, ownerA.id, 'r4', { startedHoursAgo: 10 });
    await record(orgB.id, ownerB.id, 'b1', { startedHoursAgo: 120, logsHoursAgo: [20] });
    await record(orgB.id, ownerB.id, 'b2', { startedHoursAgo: 12, trial: { endsAt: null } });

    // ── The API, MARKETING org A, with the window and without.
    await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST)); // MARKETING-org account => marketing host only (#2590)
    await signInAndSettle(page, adminA.email, PW, '/admin');
    const window = `?from=${ymd(ago(72))}&to=${ymd(new Date())}`;
    for (const qs of [window, '']) {
      const body = await (await page.request.get(`/api/admin/analytics/funnel${qs}`)).json();
      expect(body.medianFirstContactHours, `median ${qs || '(no range)'}`).toBe(6);
      expect(body.firstContact).toEqual({ medianHours: 6, contacted: 3, waiting: 1, contactedBefore: 0 });
      expect(body.trialEndCoverage).toEqual({ total: 2, withEnd: 1, rate: 50 });
    }

    // ── The screen: the two boxes, in English.
    await page.context().addCookies([{ name: 'locale', value: 'en', url: baseURL! }]);
    await gotoSettled(page, '/admin/analytics');
    await expect(page.getByTestId('golive-first-contact-value')).toHaveText('6 h', { timeout: 20_000 });
    await expect(page.getByTestId('golive-first-contact-detail')).toHaveText('3 contacted · 1 waiting');
    await expect(page.getByTestId('golive-trial-coverage-value')).toHaveText('50%');
    await expect(page.getByTestId('golive-trial-coverage-detail')).toHaveText('1 of 2');

    // ── An INTERNSHIP org: no keys, no card.
    const internship = await browser.newContext();
    try {
      expect((await signInViaApi(internship.request, adminI.email, PW)).ok).toBe(true);
      const body = await (await internship.request.get('/api/admin/analytics/funnel')).json();
      expect(body).toHaveProperty('conversions');
      expect(body).not.toHaveProperty('medianFirstContactHours');
      expect(body).not.toHaveProperty('trialEndCoverage');
    } finally {
      await internship.close();
    }
  } finally {
    const orgIds = [orgA.id, orgB.id, orgI.id];
    await prisma.interactionLog.deleteMany({ where: { relation: { orgId: { in: orgIds } } } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: { in: orgIds } } });
    await prisma.companyInquiry.deleteMany({ where: { orgId: { in: orgIds } } });
    for (const email of emails) await cleanupByEmail(email);
    await prisma.company.deleteMany({ where: { orgId: { in: orgIds } } });
    await prisma.pipelineStage.deleteMany({ where: { orgId: { in: orgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  }
});
