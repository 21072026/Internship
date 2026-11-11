import { test, expect, request as playwrightRequest } from '@playwright/test';
import crypto from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

// The relation timeline, completed (#1700): mentor questions and the pairing's
// own evaluations join the feed; the mentee sees an evaluation as a FACT and a
// date only (no score, no comment, no author); anyone who is neither a
// participant nor an admin reaching the relation gets 404, not 403; and a
// PROGRAM_ADMIN reads it through a grant on its programme (the subject-less
// permission question used to refuse every one).

const PASSWORD = 'TimelineAccess123!';
const SECRET_COMMENT = `SECRET-EVAL-COMMENT-${crypto.randomBytes(3).toString('hex')}`;

test.afterAll(async () => prisma.$disconnect());

async function ctxFor(email: string) {
  const ctx = await playwrightRequest.newContext({ baseURL: test.info().project.use.baseURL });
  const res = await signInViaApi(ctx, email, PASSWORD);
  expect(res.ok, `sign-in failed for ${email}: ${res.error}`).toBe(true);
  return ctx;
}

type Entry = { id: string; kind: string; event: string; title: string | null; detail: string | null; actor: string | null };

test('timeline: questions and evaluations join it, the mentee sees an evaluation as a fact only, outsiders get 404, a granted programme admin reads it', { tag: '@smoke' }, async () => {
  const s = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `Timeline ${s}`, slug: `timeline-acc-${s}`, plan: 'ENTERPRISE' } });
  const emails = ['ta-admin', 'ta-prog', 'ta-prog2', 'ta-mentor', 'ta-mentee', 'ta-other'].map((p) => uniqueEmail(p).toLowerCase());
  const [adminEmail, progEmail, prog2Email, mentorEmail, menteeEmail, otherEmail] = emails;
  try {
    const admin = await seedUser(adminEmail, PASSWORD, 'ADMIN', 'Timeline Org Admin', org.id);
    await prisma.user.update({ where: { id: admin.id }, data: { adminLevel: 'ORG_ADMIN' } });
    const prog = await seedUser(progEmail, PASSWORD, 'ADMIN', 'Timeline Program Admin', org.id);
    const prog2 = await seedUser(prog2Email, PASSWORD, 'ADMIN', 'Timeline Other Program Admin', org.id);
    await prisma.user.updateMany({ where: { id: { in: [prog.id, prog2.id] } }, data: { adminLevel: 'PROGRAM_ADMIN' } });
    const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Timeline Access Mentor', org.id);
    const mentee = await seedUser(menteeEmail, PASSWORD, 'MENTEE', 'Timeline Access Mentee', org.id);
    await seedUser(otherEmail, PASSWORD, 'MENTOR', 'Timeline Outsider', org.id);

    const programme = await prisma.cohort.create({ data: { orgId: org.id, name: `Timeline programme ${s}` } });
    const elsewhere = await prisma.cohort.create({ data: { orgId: org.id, name: `Other programme ${s}` } });
    await prisma.adminScopeGrant.create({ data: { userId: prog.id, orgId: org.id, cohortId: programme.id, createdById: admin.id } });
    await prisma.adminScopeGrant.create({ data: { userId: prog2.id, orgId: org.id, cohortId: elsewhere.id, createdById: admin.id } });
    const relation = await prisma.mentorshipRelation.create({
      data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee.id, cohortId: programme.id },
    });

    const now = Date.now();
    const asked = await prisma.mentorQuestion.create({
      data: { relationId: relation.id, askedById: mentee.id, question: 'How do I prepare for the panel?', createdAt: new Date(now - 4 * 3600_000) },
    });
    const answered = await prisma.mentorQuestion.create({
      data: {
        relationId: relation.id,
        askedById: mentee.id,
        question: 'Which stack should I learn?',
        answer: 'Start with the one the team uses.',
        createdAt: new Date(now - 6 * 3600_000),
        answeredAt: new Date(now - 3 * 3600_000),
      },
    });
    const interim = await prisma.evaluation.create({
      data: {
        relationId: relation.id,
        authorId: mentor.id,
        type: 'INTERIM',
        scores: { communication: 2, technical: 5 },
        comment: SECRET_COMMENT,
        submittedAt: new Date(now - 2 * 3600_000),
        createdAt: new Date(now - 2 * 3600_000),
      },
    });
    // Neither of these is history of the pairing: an unsubmitted record, and an
    // interview panel's scorecard that happens to carry the relation id.
    const draft = await prisma.evaluation.create({
      data: { relationId: relation.id, authorId: mentor.id, type: 'FINAL', scores: { technical: 1 }, comment: 'draft', submittedAt: null },
    });
    const interview = await prisma.evaluation.create({
      data: { relationId: relation.id, authorId: admin.id, type: 'INTERVIEW', scores: { technical: 3 }, submittedAt: new Date(now - 3600_000) },
    });

    const url = `/api/mentorship/${relation.id}/timeline?limit=50`;
    const entriesOf = async (ctx: Awaited<ReturnType<typeof ctxFor>>) => {
      const res = await ctx.get(url);
      expect(res.status()).toBe(200);
      const text = await res.text();
      return { text, entries: (JSON.parse(text).entries as Entry[]), kinds: JSON.parse(text).kinds as string[] };
    };
    const byId = (entries: Entry[], kind: string, id: string) => entries.find((e) => e.id.startsWith(`${kind}:`) && e.id.endsWith(`:${id}`));

    // --- the mentor: everything, with the evaluation's comment and author ---
    const m = await ctxFor(mentorEmail);
    const forMentor = await entriesOf(m);
    expect(forMentor.kinds).toEqual(expect.arrayContaining(['question', 'evaluation']));
    expect(byId(forMentor.entries, 'question', asked.id)).toMatchObject({ event: 'question_asked', title: 'How do I prepare for the panel?', actor: 'Timeline Access Mentee' });
    expect(byId(forMentor.entries, 'question', answered.id)).toMatchObject({ event: 'question_answered', detail: 'Start with the one the team uses.' });
    expect(byId(forMentor.entries, 'evaluation', interim.id)).toMatchObject({ event: 'evaluation_interim', detail: SECRET_COMMENT, actor: 'Timeline Access Mentor' });
    expect(byId(forMentor.entries, 'evaluation', draft.id)).toBeUndefined();
    expect(byId(forMentor.entries, 'evaluation', interview.id)).toBeUndefined();
    // One descending time order across kinds.
    const times = forMentor.entries.map((e) => (e as unknown as { at: string }).at);
    expect([...times].sort().reverse()).toEqual(times);
    // The kinds filter narrows to questions alone.
    const onlyQuestions = (await (await m.get(`${url}&kinds=question`)).json()).entries as Entry[];
    expect(onlyQuestions.map((e) => e.kind)).toEqual(['question', 'question']);
    await m.dispose();

    // --- the mentee: the evaluation as a fact and a date — nothing else ---
    const me = await ctxFor(menteeEmail);
    const forMentee = await entriesOf(me);
    const factOnly = byId(forMentee.entries, 'evaluation', interim.id);
    expect(factOnly).toMatchObject({ event: 'evaluation_interim', detail: null, actor: null, title: null });
    expect(forMentee.text).not.toContain(SECRET_COMMENT);
    expect(forMentee.text).not.toContain('communication');
    expect(forMentee.text).not.toContain('"scores"');
    expect(byId(forMentee.entries, 'question', answered.id)).toMatchObject({ event: 'question_answered' });
    expect(forMentee.kinds).not.toContain('note');
    await me.dispose();

    // --- someone who is neither a participant nor an admin reaching it: 404 ---
    const outsider = await ctxFor(otherEmail);
    expect((await outsider.get(url)).status()).toBe(404);
    await outsider.dispose();

    // --- a PROGRAM_ADMIN: through a grant on the relation's programme only ---
    const p = await ctxFor(progEmail);
    const forProg = await entriesOf(p);
    expect(byId(forProg.entries, 'evaluation', interim.id)).toMatchObject({ detail: SECRET_COMMENT });
    await p.dispose();
    const p2 = await ctxFor(prog2Email);
    expect((await p2.get(url)).status()).toBe(404);
    await p2.dispose();

    // --- the org admin keeps its reach ---
    const a = await ctxFor(adminEmail);
    expect((await a.get(url)).status()).toBe(200);
    await a.dispose();
  } finally {
    await prisma.evaluation.deleteMany({ where: { relation: { orgId: org.id } } }).catch(() => {});
    await prisma.mentorQuestion.deleteMany({ where: { relation: { orgId: org.id } } }).catch(() => {});
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    for (const e of emails) await cleanupByEmail(e);
    await prisma.cohort.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  }
});
