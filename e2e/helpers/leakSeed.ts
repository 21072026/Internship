import crypto from 'crypto';
import { prisma } from './db';
import type { SeededTenant, TwoTenants } from './tenants';

/**
 * The rows the leak matrix (#1568) needs on top of the two-tenant fixture.
 *
 * `seedTwoTenants()` gives each tenant its people, a company, a relation, a
 * tag, a stage set, an invitation and an offer. The matrix probes more
 * surfaces than that — cohorts, the activity log, webhooks, API keys, the
 * settings chain, evaluation templates, document requirements, interview
 * panels, requisitions — and every one of them needs a row of each tenant's
 * own, or "tenant B sees none of A's rows" is true merely because A has none.
 *
 * It also seeds the CHILD rows the issue names — models with no `orgId` of
 * their own, reached through a scoped parent: StatusChange, InteractionLog,
 * Message, Goal, Evaluation, InterviewPanelMember, UserTag.
 *
 * Every marker string carries the tenant label and the run's stamp, so a leak
 * is unambiguous in a response body, and `cleanupLeakRows()` removes exactly
 * what was written here (the fixture's own cleanup cannot: Cohort and ApiKey
 * point at the organization without a cascade). Synthetic only.
 */
export type LeakRows = {
  cohort: { id: string; name: string };
  activity: { id: string; detail: string };
  webhook: { id: string; url: string };
  apiKey: { id: string; name: string };
  supportEmail: string;
  evaluationTemplate: { id: string; name: string };
  documentRequirement: { id: string; key: string };
  panel: { id: string; title: string };
  requisition: { id: string; title: string };
  statusChange: { id: string };
  interaction: { id: string; notes: string };
  message: { id: string; body: string };
  goal: { id: string; title: string };
  evaluation: { id: string; comment: string };
  panelMember: { id: string };
  userTag: { id: string };
};

async function seedFor(t: SeededTenant, stamp: string): Promise<LeakRows> {
  const mark = (what: string) => `Iso ${t.label} ${what} ${stamp}`;
  const orgId = t.org.id;

  const cohort = await prisma.cohort.create({ data: { orgId, name: mark('Cohort') } });
  const activity = await prisma.activityLog.create({
    data: { orgId, action: 'iso.leak_probe', actorId: t.admin.id, actorEmail: t.admin.email, detail: mark('Activity') },
  });
  const webhook = await prisma.webhook.create({
    data: { orgId, url: `https://iso-${t.label.toLowerCase()}-${stamp}.example/hook`, secret: crypto.randomBytes(16).toString('hex'), events: [] },
  });
  const apiKey = await prisma.apiKey.create({
    data: { orgId, name: mark('Key'), hashedKey: crypto.randomBytes(32).toString('hex'), createdById: t.admin.id },
  });
  const supportEmail = `iso-support-${t.label.toLowerCase()}-${stamp}@iso.example`;
  await prisma.setting.create({ data: { orgId, key: 'supportEmail', value: supportEmail } });
  const evaluationTemplate = await prisma.evaluationTemplate.create({
    data: { orgId, name: mark('Template'), scope: 'MENTEE' },
  });
  const documentRequirement = await prisma.documentRequirement.create({
    data: { orgId, key: `iso_${t.label.toLowerCase()}_${stamp.replace(/[^a-z0-9]/gi, '')}`, labels: { en: mark('Doc') } },
  });
  const panel = await prisma.interviewPanel.create({
    data: { orgId, subjectId: t.mentee.id, title: mark('Panel'), createdById: t.admin.id },
  });
  const panelMember = await prisma.interviewPanelMember.create({ data: { panelId: panel.id, userId: t.mentor.id } });
  const requisition = await prisma.requisition.create({
    data: { orgId, companyId: t.company.id, title: mark('Requisition'), openings: 1 },
  });

  const relationId = t.relation.id;
  const statusChange = await prisma.statusChange.create({
    data: { relationId, fromStatus: 'INTERNSHIP_STARTING_300', toStatus: 'INTERNSHIP_IN_PROGRESS_450' },
  });
  const interaction = await prisma.interactionLog.create({
    data: { relationId, date: new Date(), notes: mark('Interaction'), type: 'Meeting' },
  });
  const message = await prisma.message.create({ data: { relationId, senderId: t.mentor.id, body: mark('Message') } });
  const goal = await prisma.goal.create({ data: { relationId, title: mark('Goal') } });
  const evaluation = await prisma.evaluation.create({
    data: { relationId, authorId: t.mentor.id, comment: mark('Evaluation') },
  });
  const userTag = await prisma.userTag.create({ data: { userId: t.mentee.id, tagId: t.tag.id } });

  return {
    cohort: { id: cohort.id, name: cohort.name },
    activity: { id: activity.id, detail: activity.detail ?? '' },
    webhook: { id: webhook.id, url: webhook.url },
    apiKey: { id: apiKey.id, name: apiKey.name },
    supportEmail,
    evaluationTemplate: { id: evaluationTemplate.id, name: evaluationTemplate.name },
    documentRequirement: { id: documentRequirement.id, key: documentRequirement.key },
    panel: { id: panel.id, title: panel.title ?? '' },
    requisition: { id: requisition.id, title: requisition.title },
    statusChange: { id: statusChange.id },
    interaction: { id: interaction.id, notes: interaction.notes },
    message: { id: message.id, body: message.body },
    goal: { id: goal.id, title: goal.title },
    evaluation: { id: evaluation.id, comment: evaluation.comment ?? '' },
    panelMember: { id: panelMember.id },
    userTag: { id: userTag.id },
  };
}

export type LeakTenants = { A: LeakRows; B: LeakRows };

/** Seed both tenants' extra rows. On a partial failure, removes what it wrote. */
export async function seedLeakRows(tenants: TwoTenants): Promise<LeakTenants> {
  const stamp = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
  try {
    return { A: await seedFor(tenants.orgA, stamp), B: await seedFor(tenants.orgB, stamp) };
  } catch (error) {
    await cleanupLeakRows(tenants.orgIds).catch(() => {});
    throw error;
  }
}

/**
 * Remove everything `seedLeakRows()` wrote, scoped to the fixture's org ids.
 * Run BEFORE `tenants.cleanup()`: Cohort and ApiKey hold the organization
 * without a cascade, and the child rows hold the relation.
 */
export async function cleanupLeakRows(orgIds: string[]): Promise<void> {
  const org = { orgId: { in: orgIds } };
  const rel = { relation: org };
  await prisma.statusChange.deleteMany({ where: rel });
  await prisma.interactionLog.deleteMany({ where: rel });
  await prisma.message.deleteMany({ where: rel });
  await prisma.goal.deleteMany({ where: rel });
  await prisma.evaluation.deleteMany({ where: rel });
  await prisma.interviewPanelMember.deleteMany({ where: { panel: org } });
  await prisma.interviewPanel.deleteMany({ where: org });
  await prisma.requisition.deleteMany({ where: org });
  await prisma.documentRequirement.deleteMany({ where: org });
  await prisma.evaluationTemplate.deleteMany({ where: org });
  await prisma.setting.deleteMany({ where: org });
  await prisma.apiKey.deleteMany({ where: org });
  await prisma.webhook.deleteMany({ where: org });
  await prisma.activityLog.deleteMany({ where: org });
  await prisma.mentorshipRelation.updateMany({ where: org, data: { cohortId: null } });
  await prisma.cohort.deleteMany({ where: org });
}
