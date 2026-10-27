// The stage-automation action handlers (#1703) — one per allowlisted action in
// ./rule.ts, and nothing else. Server-only (Prisma).
//
// Every handler:
//   • reads the relation's OWN people (its mentor, its mentee, its company's
//     active users, its org's active admins) — never an address from the rule;
//   • re-checks that any row the rule names (a tag, a document requirement, a
//     goal template) belongs to the run's org — the write-time check (#1704's
//     routes) can be outrun by a deleted or re-homed row;
//   • goes through the product's single paths: `notifyIfAllowed()` for the bell
//     (the recipient's category switch), `sendAutomationEmail()` → `sendEmail()`
//     for mail (the central unsubscribe check, the outbound approval hold, the
//     customer-mail lock, the EmailLog row) — so an unsubscribed recipient is
//     skipped by the same check every other mail passes;
//   • returns `ok` / `skipped` with a code, or throws (recorded `failed`).
//
// None of them moves a stage, and none restricts what a mentor or a mentee can
// do (free core).

import { prisma } from '@/lib/prisma';
import { notifyIfAllowed } from '@/lib/notify';
import { notificationLink, type NotificationRole } from '@/lib/notificationLink';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { resolveTemplateTitle } from '@/lib/goalTemplates';
import { requirementLabel } from '@/lib/documentRequirements';
import { isSatisfied } from '@/lib/documentReview';
import { MAX_TAGS_PER_USER } from '@/lib/tags';
import { sendAutomationEmail } from '@/services/emailService';
import { defaultLocale, isLocale, type Locale } from '@/i18n/config';
import { AUTOMATION_EMAIL_TEMPLATES, type AutomationAction } from './rule';
import type { ActionContext } from './engine';

type Outcome = { status: 'ok' | 'skipped'; detail?: string };

const localeOf = (lang: string | null | undefined): Locale => (isLocale(lang ?? undefined) ? (lang as Locale) : defaultLocale);

async function stageLabelFor(orgId: string, key: string, locale: Locale): Promise<string> {
  const stages = await resolvePipelineStages(orgId, locale);
  return stages.find((s) => s.key === key)?.label || key;
}

async function personOf(id: string) {
  return prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, fullName: true, isActive: true, preferredLanguage: true, orgId: true },
  });
}

/** The mentee's portal half exists only where the vertical has `mentorship` (stageChangeEffects.ts). */
async function menteeHasPortal(orgId: string): Promise<boolean> {
  return (await shellCapabilities(orgId)).includes('mentorship');
}

async function notifyRole(action: Extract<AutomationAction, { type: 'notifyRole' }>, ctx: ActionContext): Promise<Outcome> {
  const rel = ctx.relation;
  const capabilities = await shellCapabilities(ctx.orgId);
  if (action.role === 'mentee') {
    if (!capabilities.includes('mentorship')) return { status: 'skipped', detail: 'no_portal' };
    const mentee = await personOf(rel.menteeId);
    if (!mentee?.isActive || mentee.orgId !== ctx.orgId) return { status: 'skipped', detail: 'no_recipient' };
    const stage = await stageLabelFor(ctx.orgId, ctx.toStage, localeOf(mentee.preferredLanguage));
    await notifyIfAllowed(mentee.id, 'stageUpdates', 'automation.stageReachedSelf', { stage }, notificationLink('MENTEE', 'dashboard', {}, { capabilities }));
    return { status: 'ok', detail: 'notified:1' };
  }

  let recipients: { id: string; preferredLanguage: string | null }[] = [];
  let role: NotificationRole = 'ADMIN';
  if (action.role === 'mentor') {
    role = 'MENTOR';
    recipients = await prisma.user.findMany({ where: { id: rel.mentorId, orgId: ctx.orgId, isActive: true }, select: { id: true, preferredLanguage: true } });
  } else if (action.role === 'company') {
    role = 'COMPANY';
    if (!rel.companyId) return { status: 'skipped', detail: 'no_company' };
    recipients = await prisma.user.findMany({
      where: { companyId: rel.companyId, role: 'COMPANY', orgId: ctx.orgId, isActive: true },
      select: { id: true, preferredLanguage: true },
      take: 50,
    });
  } else {
    recipients = await prisma.user.findMany({
      where: { role: 'ADMIN', orgId: ctx.orgId, isActive: true },
      select: { id: true, preferredLanguage: true },
      take: 50,
    });
  }
  if (recipients.length === 0) return { status: 'skipped', detail: 'no_recipient' };
  const mentee = await prisma.user.findUnique({ where: { id: rel.menteeId }, select: { fullName: true } });
  const link = notificationLink(role, 'relation', { relationId: rel.id, menteeId: rel.menteeId }, { capabilities });
  for (const r of recipients) {
    const stage = await stageLabelFor(ctx.orgId, ctx.toStage, localeOf(r.preferredLanguage));
    await notifyIfAllowed(r.id, 'stageUpdates', 'automation.stageReached', { name: mentee?.fullName ?? '', stage }, link);
  }
  return { status: 'ok', detail: `notified:${recipients.length}` };
}

async function sendTemplateEmail(action: Extract<AutomationAction, { type: 'sendTemplateEmail' }>, ctx: ActionContext): Promise<Outcome> {
  const rel = ctx.relation;
  const recipientRole = AUTOMATION_EMAIL_TEMPLATES[action.template].recipient;
  if (recipientRole === 'mentee' && !(await menteeHasPortal(ctx.orgId))) return { status: 'skipped', detail: 'no_portal' };
  const recipient = await personOf(recipientRole === 'mentee' ? rel.menteeId : rel.mentorId);
  if (!recipient?.isActive || recipient.orgId !== ctx.orgId || !recipient.email) return { status: 'skipped', detail: 'no_recipient' };
  const mentee = recipientRole === 'mentee' ? recipient : await personOf(rel.menteeId);
  const locale = localeOf(recipient.preferredLanguage);
  const result = await sendAutomationEmail({
    to: recipient.email,
    userId: recipient.id,
    template: action.template,
    name: recipient.fullName,
    menteeName: mentee?.fullName ?? '',
    stage: await stageLabelFor(ctx.orgId, ctx.toStage, locale),
    locale,
    orgId: ctx.orgId,
  });
  // SKIPPED is the central gate's answer (unsubscribed, suppressed, locked).
  return result === 'SKIPPED' ? { status: 'skipped', detail: 'mail_skipped' } : { status: 'ok', detail: `mail:${result.toLowerCase()}` };
}

async function setStageDeadline(action: Extract<AutomationAction, { type: 'setStageDeadline' }>, ctx: ActionContext): Promise<Outcome> {
  const stageDeadline = new Date(ctx.now.getTime() + action.days * 86_400_000);
  // Guarded on the stage it was meant for: a relation that moved on since keeps its own deadline.
  const { count } = await prisma.mentorshipRelation.updateMany({
    where: { id: ctx.relation.id, orgId: ctx.orgId, pipelineStatus: ctx.relation.pipelineStatus },
    data: { stageDeadline, deadlineReminderSentAt: null },
  });
  return count === 1 ? { status: 'ok' } : { status: 'skipped', detail: 'left_stage' };
}

async function assignGoalFromTemplate(action: Extract<AutomationAction, { type: 'assignGoalFromTemplate' }>, ctx: ActionContext): Promise<Outcome> {
  const template = await prisma.projectTaskTemplate.findFirst({
    where: { id: action.templateId, orgId: ctx.orgId, archivedAt: null },
    select: { title: true, translations: true },
  });
  if (!template) throw new Error('not_found: goal template');
  const mentee = await personOf(ctx.relation.menteeId);
  // Worded in the mentee's language — the person whose goal it is — and shared with the pair.
  const title = resolveTemplateTitle(template, mentee?.preferredLanguage).slice(0, 191);
  await prisma.goal.create({ data: { relationId: ctx.relation.id, title, visibility: 'PAIR' } });
  return { status: 'ok' };
}

async function requireDocument(action: Extract<AutomationAction, { type: 'requireDocument' }>, ctx: ActionContext): Promise<Outcome> {
  const requirement = await prisma.documentRequirement.findFirst({
    where: { id: action.requirementId, orgId: ctx.orgId, active: true },
    select: { id: true, key: true, labels: true, approvalMode: true },
  });
  if (!requirement) throw new Error('not_found: document requirement');
  if (!(await menteeHasPortal(ctx.orgId))) return { status: 'skipped', detail: 'no_portal' };
  const mentee = await personOf(ctx.relation.menteeId);
  if (!mentee?.isActive || mentee.orgId !== ctx.orgId) return { status: 'skipped', detail: 'no_recipient' };
  const documents = await prisma.document.findMany({
    where: { ownerId: mentee.id, isTemplate: false, requirementId: requirement.id },
    select: { requirementId: true, reviewStatus: true, validUntil: true },
  });
  if (isSatisfied(requirement, documents, ctx.now)) return { status: 'skipped', detail: 'already_satisfied' };
  const document = requirementLabel(requirement.labels, localeOf(mentee.preferredLanguage), requirement.key);
  await notifyIfAllowed(mentee.id, 'documents', 'automation.documentRequired', { document }, '/portal/profile');
  return { status: 'ok' };
}

async function addTag(action: Extract<AutomationAction, { type: 'addTag' }>, ctx: ActionContext): Promise<Outcome> {
  const tag = await prisma.tag.findFirst({ where: { id: action.tagId, orgId: ctx.orgId }, select: { id: true } });
  if (!tag) throw new Error('not_found: tag');
  const userId = ctx.relation.menteeId;
  if ((await prisma.userTag.count({ where: { userId, tagId: tag.id } })) > 0) return { status: 'skipped', detail: 'already_tagged' };
  if ((await prisma.userTag.count({ where: { userId } })) >= MAX_TAGS_PER_USER) return { status: 'skipped', detail: 'user_limit' };
  // Idempotent like the manual route: applying a label twice is a no-op. No addedById — a rule added it.
  await prisma.userTag.upsert({ where: { userId_tagId: { userId, tagId: tag.id } }, update: {}, create: { userId, tagId: tag.id } });
  return { status: 'ok' };
}

/** Dispatch one allowlisted action. The switch is exhaustive over the allowlist. */
export async function executeAutomationAction(action: AutomationAction, ctx: ActionContext): Promise<Outcome> {
  switch (action.type) {
    case 'notifyRole':
      return notifyRole(action, ctx);
    case 'sendTemplateEmail':
      return sendTemplateEmail(action, ctx);
    case 'setStageDeadline':
      return setStageDeadline(action, ctx);
    case 'assignGoalFromTemplate':
      return assignGoalFromTemplate(action, ctx);
    case 'requireDocument':
      return requireDocument(action, ctx);
    case 'addTag':
      return addTag(action, ctx);
    default: {
      const never: never = action;
      throw new Error(`unknown action ${(never as { type?: string }).type}`);
    }
  }
}
