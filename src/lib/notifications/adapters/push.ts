// The push channel (#1715): any catalogue event whose `defaultChannels` list
// `push` (the reasoning is in catalog.ts) reaches the person's subscribed
// browsers and app installs through `sendPushToUser()` — the one sender, which
// already handles VAPID being unset (web push off, native push still on),
// endpoint pruning and the recipient's world icon.
//
// The tray line is the same sentence the bell shows: `renderNotification()` over
// the event's dictionary template in the RECIPIENT's locale, so the two never
// say different things. The URL is the router's relative deep link, which opens
// the recipient's own product on the host they subscribed from (webPush.ts).
// One-shot events do not collapse: each gets its own tray entry.
//
// No device anywhere is a SKIPPED `no_device` row, not a silent no-op — the
// ledger shows who could not be reached by push and why.
import { getDictionary } from '@/i18n/dictionaries';
import { renderNotification } from '@/lib/notificationText';
import { sendPushToUser } from '@/lib/webPush';
import type { ChannelAdapter } from './types';

export const pushAdapter: ChannelAdapter = {
  id: 'push',
  available: () => true,
  deliver: async (d) => {
    try {
      const title = renderNotification({ type: d.def.key, params: d.params }, getDictionary(d.locale), d.locale);
      const reached = await sendPushToUser(d.userId, d.def.category, { title, body: '', url: d.link });
      return reached > 0 ? { status: 'SENT' } : { status: 'SKIPPED', reason: 'no_device' };
    } catch (e) {
      return { status: 'FAILED', error: String(e) };
    }
  },
};
