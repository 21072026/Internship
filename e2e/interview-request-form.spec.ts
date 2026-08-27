import { test, expect, type Page, type Locator } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { prisma, uniqueEmail } from './helpers/db';
import { companyInterestScopeKey } from '@/lib/companyInterests';
import { interviewActiveKey } from '@/lib/interviewRequests';

// Story #942-adjacent: the "request interview" form (note + up to 5 proposed
// slots) that sits on top of the already-existing API/queue. See
// src/components/InterviewRequestForm.tsx.
const stamp = `${Date.now()}-${Math.round(Math.random() * 10000)}`;
const password = 'InterviewFormPass123!';
const emails = {
  company: uniqueEmail('irf-company'),
  mentor: uniqueEmail('irf-mentor'),
  menteeWithNote: uniqueEmail('irf-mentee-note'),
  menteeBare: uniqueEmail('irf-mentee-bare'),
};
let org: { id: string };
let company: { id: string };
let mentor: { id: string };
let menteeWithNote: { id: string };
let menteeBare: { id: string };
let requisition: { id: string };
let relationWithNote: { id: string };

async function login(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith('/auth/signin'));
}

// Scoped by data-testid (src/app/company/requisitions/[id]/page.tsx) rather
// than DOM order — the shortlist API returns rows by updatedAt desc, not
// insertion order, so an order-based locator would silently point at the
// wrong candidate's form.
function candidateRow(page: Page, menteeId: string): Locator {
  return page.getByTestId(`shortlist-candidate-${menteeId}`);
}

// datetime-local input value, a few days out, well-formed for `fill()`.
function futureLocalSlot(daysFromNow: number) {
  const d = new Date('2026-09-01T00:00:00.000Z');
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return `${d.toISOString().slice(0, 10)}T10:00`;
}

test.describe.serial('Interview request form (note + proposed slots)', () => {
  test.beforeAll(async () => {
    const hash = await bcrypt.hash(password, 10);
    org = await prisma.organization.create({ data: { name: `IRF ${stamp}`, slug: `irf-${stamp}` } });
    company = await prisma.company.create({ data: { name: `IRF Co ${stamp}`, orgId: org.id } });
    const user = (email: string, role: 'ADMIN' | 'COMPANY' | 'MENTOR' | 'MENTEE', companyId?: string) =>
      prisma.user.create({ data: { email, password: hash, role, fullName: email.split('@')[0], orgId: org.id, companyId, skills: [] } });
    await user(emails.company, 'COMPANY', company.id);
    mentor = await user(emails.mentor, 'MENTOR');
    menteeWithNote = await user(emails.menteeWithNote, 'MENTEE');
    menteeBare = await user(emails.menteeBare, 'MENTEE');
    relationWithNote = await prisma.mentorshipRelation.create({
      data: { orgId: org.id, companyId: company.id, mentorId: mentor.id, menteeId: menteeWithNote.id, status: 'ACTIVE', pipelineStatus: 'APPLICATION_100' },
    });
    await prisma.mentorshipRelation.create({
      data: { orgId: org.id, companyId: company.id, mentorId: mentor.id, menteeId: menteeBare.id, status: 'ACTIVE', pipelineStatus: 'APPLICATION_100' },
    });
    requisition = await prisma.requisition.create({ data: { orgId: org.id, companyId: company.id, title: `IRF Req ${stamp}`, openings: 2, requiredSkills: [] } });
    await prisma.companyInterest.create({
      data: { companyId: company.id, menteeId: menteeWithNote.id, requisitionId: requisition.id, status: 'SHORTLISTED', scopeKey: companyInterestScopeKey(company.id, menteeWithNote.id, requisition.id) },
    });
    await prisma.companyInterest.create({
      data: { companyId: company.id, menteeId: menteeBare.id, requisitionId: requisition.id, status: 'SHORTLISTED', scopeKey: companyInterestScopeKey(company.id, menteeBare.id, requisition.id) },
    });
  });

  test.afterAll(async () => {
    await prisma.notification.deleteMany({ where: { userId: { in: [menteeWithNote?.id, menteeBare?.id].filter(Boolean) } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [mentor?.id].filter(Boolean) } } }).catch(() => {});
    await prisma.interviewRequest.deleteMany({ where: { requisitionId: requisition?.id } }).catch(() => {});
    await prisma.companyInterest.deleteMany({ where: { requisitionId: requisition?.id } }).catch(() => {});
    await prisma.mentorshipRelation.deleteMany({ where: { companyId: company?.id } }).catch(() => {});
    await prisma.requisition.deleteMany({ where: { id: requisition?.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: company?.id } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: org?.id } }).catch(() => {});
    await prisma.$disconnect();
  });

  test('note + slots: a 6th slot is blocked in the UI, remove works, and the ISO instant sent is accepted by the schema', async ({ page }) => {
    await login(page, emails.company);
    await page.goto(`/company/requisitions/${requisition.id}`);
    const row = candidateRow(page, menteeWithNote.id);

    await row.getByTestId('interview-request-note').fill('Please interview this candidate soon.');

    const addSlot = row.getByTestId('interview-request-add-slot');
    for (let i = 0; i < 5; i++) await addSlot.click();
    // 5 slots added — the 6th add must be a client-side no-op (button disabled).
    await expect(addSlot).toBeDisabled();
    await expect(row.getByTestId('interview-request-slot-4')).toBeVisible();
    await expect(row.getByTestId('interview-request-slot-5')).toHaveCount(0);

    // Remove one slot, leaving 4, and confirm the add button re-enables.
    await row.getByTestId('interview-request-remove-slot-4').click();
    await expect(row.getByTestId('interview-request-slot-4')).toHaveCount(0);
    await expect(addSlot).toBeEnabled();

    // Remove down to a single slot and fill it with a real value.
    await row.getByTestId('interview-request-remove-slot-3').click();
    await row.getByTestId('interview-request-remove-slot-2').click();
    await row.getByTestId('interview-request-remove-slot-1').click();
    await row.getByTestId('interview-request-slot-0').fill(futureLocalSlot(5));

    await row.getByTestId('interview-request-submit').click();
    await expect(row.getByText('Pending')).toBeVisible({ timeout: 10000 });

    const created = await prisma.interviewRequest.findFirstOrThrow({ where: { requisitionId: requisition.id, menteeId: menteeWithNote.id } });
    expect(created.note).toBe('Please interview this candidate soon.');
    expect(created.activeKey).toBe(interviewActiveKey(requisition.id, menteeWithNote.id));
    const slots = created.proposedSlots as string[];
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/); // ISO-8601 with offset (Z) — what new Date(local).toISOString() sends
    expect(() => new Date(slots[0]).toISOString()).not.toThrow();

    // Backend duplicate/activeKey guard is untouched: a second POST 409s.
    const dup = await page.request.post('/api/interview-requests', { data: { requisitionId: requisition.id, menteeId: menteeWithNote.id } });
    expect(dup.status()).toBe(409);
  });

  test('empty note + no slots still creates a request (both stay fully optional)', async ({ page }) => {
    await login(page, emails.company);
    await page.goto(`/company/requisitions/${requisition.id}`);
    const row = candidateRow(page, menteeBare.id);
    await row.getByTestId('interview-request-submit').click();
    await expect(row.getByText('Pending')).toBeVisible({ timeout: 10000 });

    const created = await prisma.interviewRequest.findFirstOrThrow({ where: { requisitionId: requisition.id, menteeId: menteeBare.id } });
    expect(created.note).toBeNull();
    expect(created.proposedSlots === null || (Array.isArray(created.proposedSlots) && created.proposedSlots.length === 0)).toBe(true);
  });

  test('approval keeps the scheduling link intact and the queue renders note + proposed slots', async ({ page }) => {
    const pending = await prisma.interviewRequest.findFirstOrThrow({ where: { requisitionId: requisition.id, menteeId: menteeWithNote.id } });
    await login(page, emails.mentor);
    const approved = await page.request.patch(`/api/interview-requests/${pending.id}`, { data: { action: 'approve' } });
    expect(approved.status()).toBe(200);

    await page.goto('/mentor/interview-requests');
    const queue = page.getByTestId('mentor-interview-requests');
    await expect(queue.getByText('Please interview this candidate soon.')).toBeVisible();
    // The one proposed slot from the first test renders under its own heading —
    // menteeBare's request has none, so this is the only <li> the queue has.
    await expect(queue.getByText('Proposed slots')).toBeVisible();
    await expect(queue.locator('li')).toHaveCount(1);

    const link = page.locator('a', { hasText: 'Schedule interview' }).first();
    await expect(link).toBeVisible();
    const href = await link.getAttribute('href');
    expect(href).toContain(`relationId=${relationWithNote.id}`);
    expect(href).toContain(`interviewRequestId=${pending.id}`);
    expect(href).toContain(`requisitionId=${requisition.id}`);
  });
});
