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
  // The person switched this channel off for this category (#1714).
  | 'channel_off'
  | 'no_address'
  | 'no_adapter'
  | 'unknown_event'
  | 'invalid_payload'
  // The chat adapter's (#1939): the deployment switch is off, the person has no
  // confirmed identity any more, or their workspace's admin disabled it.
  | 'chat_apps_off'
  | 'no_identity'
  | 'workspace_disabled'
  // The push adapter's (#1715): no subscribed browser and no app install.
  | 'no_device';

/**
 * What a chat card needs beyond the sentence (#1942). Only the chat adapter
 * reads it; every other channel ignores it.
 *   subjectKey — the thing the card is about (`meeting:<batchKey|id>`), so a
 *                later card about the same thing can find the earlier ones;
 *   actionUrl  — the link button (the join link); null means no button;
 *   supersede  — rewrite this person's live cards about the subject instead of
 *                posting a second card that contradicts the first.
 */
export interface ChatCard {
  subjectKey: string;
  actionUrl: string | null;
  supersede: boolean;
}

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
  /** The chat card's subject, button and supersede intent (#1942). */
  card?: ChatCard | null;
  /**
   * The push body (#1715): the message text a new-message push previews. Never
   * stored on the bell row or in the ledger — only the push adapter reads it.
   */
  preview?: string | null;
  /** A mail the call site already rendered (#1711) — see PrerenderedEmail. */
  email?: PrerenderedEmail | null;
}

/**
 * A mail the call site already built, handed to the router so the send gains the
 * ledger row, the preference check, quiet hours and the channel matrix WITHOUT
 * changing a byte of what the person receives (#1711, option 2a). The router
 * decides whether it leaves; sendEmail() gets exactly these fields, as the site
 * used to pass them. Sealed (secretBox) in the job payload, never stored clear.
 */
export interface PrerenderedEmail {
  subject: string;
  html: string;
  /** The site's own sendEmail() category — it decides the lane and the footer group. */
  category: string;
  fromName?: string | null;
  replyTo?: string;
  locale?: string | null;
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
