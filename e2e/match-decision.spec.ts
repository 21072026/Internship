import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAndSettle, signInViaApi } from './helpers/auth';

// The pairing audit record (#1789): every pairing path writes exactly one
// MatchDecision; "overrode the ranking" is computed by the server from the
// batch it recorded; the stored score is frozen — editing the rule set later
// does not rewrite it; the note lives on the decision; the trail is an audit
// read a mentor cannot make.
test('pairings write one frozen, server-judged decision each; the trail is admin-only', async ({ page, playwright, baseURL }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const pw = 'DecisionPass123!';
  const org = await prisma.organization.create({ data: { name: `Decision ${stamp}`, slug: `decision-${stamp}` } });
  const admin = await playwright.request.newContext({ baseURL });
  const mentorCtx = await playwright.request.newContext({ baseURL });
  try {
    const adminEmail = uniqueEmail('dec-admin');
    await seedUser(adminEmail, pw, 'ADMIN', 'Decision Admin', org.id);
    const skill = `Elixir${stamp.replace(/[^a-z0-9]/gi, '')}`;
    const mk = async (name: string, role: 'MENTOR' | 'MENTEE', skills: string[], email = uniqueEmail(`dec-${role.toLowerCase()}`)) => {
      const u = await seedUser(email, pw, role, name, org.id);
      await prisma.user.update({ where: { id: u.id }, data: { skills } });
      return u;
    };
    const top = await mk('Top Mentor', 'MENTOR', [skill]);
    const other = await mk('Other Mentor', 'MENTOR', []);
    const acceptEmail = uniqueEmail('dec-accept-mentor');
    const accepting = await mk('Accepting Mentor', 'MENTOR', [], acceptEmail);
    const m1 = await mk('Direct Mentee', 'MENTEE', [skill]);
    const m2 = await mk('Request Mentee', 'MENTEE', [skill]);
    const m3 = await mk('Accept Mentee', 'MENTEE', [skill]);

    expect((await signInViaApi(admin, adminEmail, pw)).ok).toBe(true);
    const suggest = async (menteeId: string) => {
      const res = await admin.post('/api/admin/mentor-suggest', { data: { menteeId } });
      expect(res.status(), await res.text()).toBe(200);
      return (await res.json()) as { batchId: string; suggestions: { mentorId: string }[] };
    };

    // 1. Direct assignment of the SECOND suggestion, with a note.
    const s1 = await suggest(m1.id);
    expect(s1.suggestions[0].mentorId).toBe(top.id);
    const assigned = await admin.post('/api/mentorship', {
      data: { mentorId: other.id, menteeId: m1.id, suggestionBatchId: s1.batchId, decisionNote: 'Same time zone, shared language.' },
    });
    expect(assigned.status(), await assigned.text()).toBe(201);
    const rel1 = (await assigned.json()).relation as { id: string };
    const d1 = await prisma.matchDecision.findMany({ where: { relationId: rel1.id } });
    expect(d1).toHaveLength(1);
    expect(d1[0]).toMatchObject({ source: 'ADMIN_DIRECT', overrodeSuggestion: true, note: 'Same time zone, shared language.', ruleSetId: null, ruleSetVersion: 1, orgId: org.id });
    expect(d1[0].suggestedRank).toBeGreaterThan(1);
    const frozen = { score: d1[0].score, breakdown: d1[0].breakdown };
    // The note went to the decision row only — not into the relation.
    expect(JSON.stringify(await prisma.mentorshipRelation.findUnique({ where: { id: rel1.id } }))).not.toContain('Same time zone');

    // 2. Request approval of the TOP suggestion: no override, rank 1.
    const req2 = await prisma.mentorshipRequest.create({ data: { menteeId: m2.id } });
    const s2 = await suggest(m2.id);
    const approved = await admin.put('/api/admin/mentorship-requests', {
      data: { requestId: req2.id, action: 'approve', mentorId: s2.suggestions[0].mentorId, suggestionBatchId: s2.batchId },
    });
    expect(approved.status(), await approved.text()).toBe(200);
    const d2 = await prisma.matchDecision.findMany({ where: { requestId: req2.id } });
    expect(d2).toHaveLength(1);
    expect(d2[0]).toMatchObject({ source: 'REQUEST_APPROVAL', overrodeSuggestion: false, suggestedRank: 1, mentorId: top.id });
    expect(d2[0].score).toBe(100);

    // 3. The mentor's own accept: MENTOR_ACCEPT, no list shown.
    const req3 = await prisma.mentorshipRequest.create({ data: { menteeId: m3.id, preferredMentorId: accepting.id } });
    expect((await signInViaApi(mentorCtx, acceptEmail, pw)).ok).toBe(true);
    const accepted = await mentorCtx.put('/api/mentor/applications', { data: { requestId: req3.id, action: 'accept' } });
    expect(accepted.status(), await accepted.text()).toBe(200);
    const d3 = await prisma.matchDecision.findMany({ where: { requestId: req3.id } });
    expect(d3).toHaveLength(1);
    expect(d3[0]).toMatchObject({ source: 'MENTOR_ACCEPT', overrodeSuggestion: false, suggestedRank: null, decidedById: accepting.id });

    // Frozen: a new default rule set (and archiving it) leaves history alone.
    const rs = await prisma.matchRuleSet.create({
      data: { orgId: org.id, name: 'Later rules', isDefault: true, version: 9, rules: { create: [{ orgId: org.id, dimension: 'city', kind: 'WEIGHTED', weight: 100 }] } },
    });
    await prisma.matchRuleSet.update({ where: { id: rs.id }, data: { archivedAt: new Date() } });
    const listed = await admin.get(`/api/admin/match-decisions?relationId=${rel1.id}`);
    expect(listed.status()).toBe(200);
    const body = (await listed.json()) as { total: number; decisions: { score: number | null; breakdown: unknown; decidedByName: string | null }[] };
    expect(body.total).toBe(1);
    expect({ score: body.decisions[0].score, breakdown: body.decisions[0].breakdown }).toEqual(frozen);
    expect(body.decisions[0].decidedByName).toBe('Decision Admin');

    // A mentor cannot read the trail.
    expect((await mentorCtx.get(`/api/admin/match-decisions?relationId=${rel1.id}`)).status()).toBe(403);

    // The panel on the relation view shows the decision and its note.
    await signInAndSettle(page, adminEmail, pw, '/admin');
    await gotoSettled(page, `/admin/candidates/${m1.id}`);
    const panel = page.getByTestId('match-decision-panel');
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByTestId('match-decision-note')).toHaveText('Same time zone, shared language.');
    await expect(panel.getByTestId('match-decision-ranking')).toContainText('Overrode the ranking');
  } finally {
    await admin.dispose();
    await mentorCtx.dispose();
    const users = await prisma.user.findMany({ where: { orgId: org.id }, select: { id: true } });
    const ids = users.map((u) => u.id);
    await prisma.matchDecision.deleteMany({ where: { orgId: org.id } });
    await prisma.matchFeedback.deleteMany({ where: { orgId: org.id } });
    await prisma.mentorshipRequest.deleteMany({ where: { menteeId: { in: ids } } });
    await prisma.mentorshipRelation.deleteMany({ where: { OR: [{ menteeId: { in: ids } }, { mentorId: { in: ids } }] } });
    await prisma.activityLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { orgId: org.id } });
    await prisma.matchRuleSet.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});
