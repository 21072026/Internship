// The e-mail channel (#1711): enqueue ONE `notification.email` job keyed
// `notify:<dedupeKey>` and leave the ledger row QUEUED. A slow or dead SMTP
// server never sits inside the request that raised the notification. The job's
// consumer — render, sendEmail(), settle the row — is ../emailJob.ts (#1719).
//
// The DECISION (category switch, e-mail master switch, e-mail group) is the
// router's, made once before the row is claimed; sendEmail() applies its own
// gate again at send time. Nothing here re-implements either.

import { enqueue } from '@/lib/jobs/queue';
// Static, not enqueue()'s lazy default: a lazy import is not resolved through the
// `@/` alias outside Next (the e2e process calling notifyEvent() directly).
import { prismaQueueStore } from '@/lib/jobs/queueStore';
import { sealEmail } from '@/lib/notifications/sealedEmail';
import type { ChannelAdapter } from './types';

export const emailAdapter: ChannelAdapter = {
  id: 'email',
  available: () => true,
  deliver: async (d) => {
    try {
      // Prefixed so the notification namespace can never collide with another
      // producer's key on the globally-unique column. A collision with our own
      // key means an earlier attempt enqueued it: the mail is owed exactly once.
      await enqueue(
        'notification.email',
        {
          eventKey: d.def.key,
          userId: d.userId,
          locale: d.locale,
          params: d.params,
          link: d.link,
          emailGroup: d.def.emailGroup,
          delivery: d.def.delivery,
          // A mail the site already rendered (#1711) is sent as it is, sealed here.
          ...(d.email ? { sealedEmail: sealEmail(d.email) } : {}),
        },
        { store: prismaQueueStore(), orgId: d.orgId, idempotencyKey: `notify:${d.dedupeKey}`, trigger: 'event' },
      );
      return { status: 'QUEUED' };
    } catch (e) {
      return { status: 'FAILED', error: String(e) };
    }
  },
};
