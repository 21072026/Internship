import { prisma } from '@/lib/prisma';
import { getDictionary } from '@/i18n/dictionaries';
import { defaultLocale, isLocale, type Locale } from '@/i18n/config';
import { renderNotification } from '@/lib/notificationText';
import { sendPushToUser, pushConfigured } from '@/lib/webPush';

/**
 * "A message arrived while you were not in the app" (#1464).
 *
 * Kept next to the message routes rather than inside `notify()`: every event in
 * the app writes a notification row, and turning all of them into a phone buzz
 * is a different (and much louder) product decision than the one asked for.
 * Messages are the channel people expect to interrupt them.
 *
 * The notification is composed in the *recipient's* language, from the same
 * dictionary template the bell renders (`notifications.events['message.new']`),
 * so the tray and the in-app row never say different things. Never throws.
 */
export async function sendNewMessagePush(
  recipientId: string,
  options: { senderName?: string | null; link: string; preview?: string | null; byEmail?: boolean },
): Promise<void> {
  if (!pushConfigured()) return;
  try {
    const recipient = await prisma.user.findUnique({
      where: { id: recipientId },
      select: { preferredLanguage: true },
    });
    const locale: Locale = isLocale(recipient?.preferredLanguage ?? undefined)
      ? (recipient!.preferredLanguage as Locale)
      : defaultLocale;
    const t = getDictionary(locale);

    const type = options.byEmail
      ? 'message.newByEmail'
      : options.senderName
        ? 'message.new'
        : 'message.newGeneric';
    const title = renderNotification(
      { type, params: options.senderName ? { from: options.senderName } : {} },
      t,
      locale,
    );

    // A one-line preview, and only a preview: a push payload is capped at a few
    // KB and a lock screen shows about this much anyway. Newlines collapse so a
    // multi-paragraph message does not arrive as a wall.
    const preview = (options.preview ?? '').replace(/\s+/g, ' ').trim();
    await sendPushToUser(recipientId, 'messages', {
      title,
      body: preview.length > 140 ? `${preview.slice(0, 139)}…` : preview,
      url: options.link,
      // One notification per thread: a burst of messages replaces itself in the
      // tray instead of stacking up.
      tag: `thread:${options.link}`,
    });
  } catch {
    /* push is an extra channel — never let it disturb the message itself */
  }
}
