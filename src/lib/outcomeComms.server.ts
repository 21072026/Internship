import { prisma } from '@/lib/prisma';
import { notifyIfAllowed } from '@/lib/notify';
import { getSetting } from '@/lib/settings';
import { emailAllowed } from '@/lib/notificationPrefs';
import { emailGroupAllowedForCategory } from '@/lib/emailGroups';
import { sendEmail } from '@/services/emailService';
import { getDictionary } from '@/i18n/dictionaries';
import { locales, type Locale } from '@/i18n/config';
import { logger } from '@/lib/logger';
import {
  OUTCOME_TEMPLATE_KEY,
  outcomeComposerLink,
  outcomeForStage,
  type OutcomeKind,
} from '@/lib/outcomeComms';

// Server half of negative-outcome communication (#830).
//
// Two deliberate constraints shape this file:
//
//  1. **Nothing is sent by default.** The mentor is *notified* that an outcome
//     was reached and handed a link into the composer with the right template
//     already filled in — they read it, edit it, and press send. A rejection is
//     the most sensitive text this product writes and the wrong message on the
//     wrong case cannot be recalled, so automatic sending is an org setting
//     (`outcomeAutoSend`) that ships off.
//  2. **One message per event.** This runs from emitStageChange — the single
//     chokepoint every pipelineStatus write goes through — and replaces the
//     generic "your stage changed" notification for the mentee rather than
//     adding to it. Two notifications about one event, one of them worded for a
//     spreadsheet, is exactly the silence-adjacent experience this fixes.

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const localeOf = (preferred?: string | null): Locale =>
  (locales as readonly string[]).includes(preferred ?? '') ? (preferred as Locale) : 'en';

/** The mentee's own in-app wording for the outcome — never the generic stage line. */
export async function notifyMenteeOfOutcome(menteeId: string, kind: OutcomeKind) {
  const type = kind === 'placedElsewhere' ? 'outcome.placedElsewhere' : 'outcome.noMatch';
  await notifyIfAllowed(menteeId, 'stageUpdates', type, undefined, '/portal');
}

/**
 * Everything that happens when a relation lands on an outcome stage, minus the
 * mentee's own notification (which emitStageChange does in place of the generic
 * one). Best-effort throughout: a stage change must never fail because a
 * message could not be composed.
 */
export async function emitOutcomeComms(opts: {
  relationId: string;
  kind: OutcomeKind;
}) {
  const { relationId, kind } = opts;
  try {
    const relation = await prisma.mentorshipRelation.findUnique({
      where: { id: relationId },
      select: {
        id: true,
        mentorId: true,
        mentee: {
          select: {
            id: true,
            email: true,
            fullName: true,
            preferredLanguage: true,
            emailNotifications: true,
            notificationPrefs: true,
          },
        },
      },
    });
    if (!relation) return;

    // The mentor is the one who writes it — they know the person.
    if (relation.mentorId) {
      await notifyIfAllowed(
        relation.mentorId,
        'stageUpdates',
        'outcome.needsMessage',
        { name: relation.mentee.fullName },
        outcomeComposerLink(relationId, kind)
      );
    }

    if ((await getSetting('outcomeAutoSend')) !== 'true') return;

    // Auto-send is on: the same template the composer would have shown, in the
    // mentee's own language, with their opt-out respected.
    const mentee = relation.mentee;
    if (!mentee.email || !emailAllowed(mentee, 'stageUpdates')) return;
    if (!emailGroupAllowedForCategory(mentee, 'outcome')) return;
    const dict = getDictionary(localeOf(mentee.preferredLanguage));
    const tpl = (dict.emailTemplates as Record<string, { subject: string; body: string }>)[
      OUTCOME_TEMPLATE_KEY[kind]
    ];
    if (!tpl) return;
    const fill = (s: string) => s.replace(/\{name\}/g, () => mentee.fullName);
    const body = fill(tpl.body);
    const subject = fill(tpl.subject);
    await sendEmail({
      to: mentee.email,
      subject,
      html: `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.6;white-space:pre-wrap">${esc(body)}</div>`,
      category: 'outcome',
      // The mentee is the only recipient — the mentor gets an in-app
      // notification above, never a copy of this mail. The body is rendered from
      // the mentee's own dictionary, so the footer takes the same language.
      userId: mentee.id,
      locale: mentee.preferredLanguage,
    });
    // Logged on the relation like every other mentor→mentee email, so the
    // history shows what the candidate was actually told.
    await prisma.interactionLog.create({
      data: {
        relationId,
        type: 'Email',
        subject,
        notes: body,
        date: new Date(),
      },
    });
  } catch (e) {
    logger.error('Outcome communication failed', { relationId, kind, error: String(e) });
  }
}

export { outcomeForStage };
