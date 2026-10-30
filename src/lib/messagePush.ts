import { prisma } from '@/lib/prisma';
import { getDictionary } from '@/i18n/dictionaries';
import { defaultLocale, isLocale, type Locale } from '@/i18n/config';
import { renderNotification } from '@/lib/notificationText';
import { sendPushToUser } from '@/lib/webPush';
import { pushPreview, supportPushTag, type SupportPushEvent } from '@/lib/supportPushRule';

/**
 * The support line is a conversation too (#3154): it is the pinned "Support"
 * thread in Messages, and its events sit in the `messages` category of the
 * notification catalogue, so the same /account switch silences them. Which
 * events push, and to whom, is src/lib/supportPushRule.ts. Never throws.
 */
export async function sendSupportPush(
  recipientId: string,
  options: { type: SupportPushEvent; params: Record<string, string>; link: string; preview?: string | null; ticketId: string },
): Promise<void> {
  await sendEventPush(recipientId, { type: options.type, params: options.params }, {
    link: options.link,
    preview: options.preview,
    tag: supportPushTag(options.ticketId),
  });
}

async function sendEventPush(
  recipientId: string,
  event: { type: string; params: Record<string, string> },
  options: { link: string; preview?: string | null; tag: string },
): Promise<void> {
  // No `pushConfigured()` gate any more (#2775): that is the WEB channel's
  // switch, and native push needs no configuration. A recipient with neither a
  // subscription nor an app install costs a few indexed reads by userId.
  try {
    const recipient = await prisma.user.findUnique({
      where: { id: recipientId },
      select: { preferredLanguage: true },
    });
    const locale: Locale = isLocale(recipient?.preferredLanguage ?? undefined)
      ? (recipient!.preferredLanguage as Locale)
      : defaultLocale;

    await sendPushToUser(recipientId, 'messages', {
      title: renderNotification(event, getDictionary(locale), locale),
      body: pushPreview(options.preview),
      url: options.link,
      tag: options.tag,
    });
  } catch {
    /* push is an extra channel — never let it disturb the message itself */
  }
}
