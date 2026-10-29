// The in-app channel (#1711): today's `notify()` — the Notification row plus the
// realtime bell signal — behind the adapter port. `notify()` swallows its own
// errors, so "it returned" is all the certainty there is; the same certainty
// every direct call site has always had.
import { notify } from '@/lib/notify';
import type { ChannelAdapter } from './types';

export const inAppAdapter: ChannelAdapter = {
  id: 'inApp',
  available: () => true,
  deliver: async (d) => {
    await notify(d.userId, d.def.key, d.params, d.link);
    return { status: 'SENT' };
  },
};
