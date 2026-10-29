// The channel adapter port (#1711): one shape every notification channel
// implements, so the router (../router.ts) decides WHETHER and records WHAT,
// and the adapter only knows HOW. A new channel is an adapter plus an entry in
// ./index.ts — the router does not change.
//
// Dependency-free (type imports only).

import type { Locale } from '@/i18n/config';
import type { NotificationParams } from '@/lib/notify';
import type { NotificationChannel, NotificationEventDef } from '../catalog';

/** Why a delivery was not attempted. Mirrors `NotificationDelivery.skipReason`. */
export type SkipReason =
  | 'category_off'
  | 'group_off'
  | 'email_off'
  | 'no_address'
  | 'no_adapter'
  | 'unknown_event'
  | 'invalid_payload'
  // The chat adapter's (#1939): the deployment switch is off, the person has no
  // confirmed identity any more, or their workspace's admin disabled it.
  | 'chat_apps_off'
  | 'no_identity'
  | 'workspace_disabled';

/** One claimed delivery, everything a channel needs to perform it. */
export interface ChannelDelivery {
  /** The `NotificationDelivery` row this delivery settles. */
  deliveryId: string;
  def: NotificationEventDef;
  userId: string;
  orgId: string | null;
  locale: Locale;
  /** Only the catalogue entry's declared placeholders. */
  params: NotificationParams;
  /** Relative, inside the recipient's own product (#2590). */
  link: string;
  dedupeKey: string;
}

export type ChannelOutcome =
  /** Done now (the bell row exists, the chat message was accepted). */
  | { status: 'SENT' }
  /** Handed to a worker that settles the ledger row itself (e-mail). */
  | { status: 'QUEUED' }
  | { status: 'SKIPPED'; reason: SkipReason }
  | { status: 'FAILED'; error: string };

export interface ChannelAdapter {
  id: NotificationChannel;
  /** False when the deployment cannot carry this channel at all. */
  available(): boolean;
  /** Never throws: a failure is a FAILED outcome. */
  deliver(delivery: ChannelDelivery): Promise<ChannelOutcome>;
}
