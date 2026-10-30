// The notification router (#1710).
//
// ONE DOOR. `notifyEvent(recipients, eventKey, payload)` is the single place a
// notification leaves the product. It resolves, per recipient:
//
//     recipient → locale → preferences → channels → ledger row → channel
//
// and it wraps the senders that already exist rather than replacing them:
// the in-app channel is `notify()` from src/lib/notify.ts (unchanged, still the
// Notification row plus the realtime bell signal), and the e-mail channel hands
// off to the durable `Job` queue instead of sending inline.
//
// WHY THE ORDER OF THOSE STEPS IS THE FEATURE
//   The preference check happens BEFORE the ledger row is claimed, and this is
//   not stylistic. docs/agent-experience.md records the dormant-first-contact
//   sweep making the opposite mistake: it stamped the "we contacted them"
//   counter first and read the opt-out second, so every opted-out person spent
//   one of their two allowed mails on a message that was never sent — the quota
//   was consumed by nothing. Here a suppressed delivery is written as SKIPPED
//   with its reason and never claims the send identity, so a later retry with
//   the same dedupe key is still free to deliver if the preference changed.
//
// NEVER THROWS, NEVER BLOCKS THE CALLER'S TRANSACTION
//   Every step is wrapped. A failed preference read, a failed ledger write, a
//   dead SMTP queue — each degrades (log + carry on) rather than turning "we
//   sent a notification" into "the action that triggered it failed". This is
//   the same contract `notify()` has always had, and it is why callers can put
//   it after their own commit without a try/catch of their own.
//
// MANDATORY EVENTS
//   An event whose e-mail group is `essential` (account_security) is delivered
//   on every requested channel regardless of preferences, in-app included.
//   Telling somebody an administrator entered their account is a disclosure,
//   not a notification, and `emailGroupAllowed()` already refuses to let the
//   mail half of it be switched off. Deriving the rule from the group rather
//   than repeating it per entry keeps the two halves from disagreeing.
//
// SHIM, NOT A REPLACEMENT (yet)
//   The 38 existing `notify(userId, type, params, link)` call sites are NOT
//   migrated here — that is its own task, and doing it in this PR would put the
//   whole comms surface behind one review. `notify` is re-exported below so a
//   call site can move its import first and its shape second, and the legacy
//   helper keeps behaving exactly as it does today: in-app only, no ledger row.

import { randomUUID, createHash } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import type { NotificationParams } from '@/lib/notify';
import { notificationCategoryAllowed } from '@/lib/notificationPrefs';
import { emailGroupAllowed, isEssentialGroup } from '@/lib/emailGroups';
import { notificationLink, type NotificationRole } from '@/lib/notificationLink';
import { capabilitiesMemo } from '@/lib/shellCapabilities';
import { chatCapableUsers, deliverChat } from '@/lib/notifications/adapters/chat';
import { CHANNEL_ADAPTERS } from '@/lib/notifications/adapters';
import type { SkipReason } from '@/lib/notifications/adapters/types';
import { claimDelivery, recordSkipped, settleDelivery, type LedgerRow } from '@/lib/notifications/ledger';
import { resolveSettingRaw } from '@/lib/settingsResolver';
import { enqueue } from '@/lib/jobs/queue';
import { prismaQueueStore } from '@/lib/jobs/queueStore';
import { NOTIFICATION_CATEGORIES } from '@/lib/notificationPrefs';
import {
  DEFERRABLE_CHANNELS,
  channelOffInMatrix,
  isValidTimeZone,
  nextOpenInstant,
  parseBlackoutDates,
  readChannelMap,
  readQuietHours,
  resolveChannels,
  type Calendar,
} from '@/lib/notificationChannelPrefs';
import { isLocale, defaultLocale, type Locale } from '@/i18n/config';
import {
  eventDef,
  validateEventPayload,
  LINK_ID_KEYS,
  type EventPayload,
  type NotificationChannel,
  type NotificationEventKey,
  type NotificationEventDef,
} from '@/lib/notifications/catalog';

// The legacy in-app-only helper, re-exported so a migrating call site can
// change `@/lib/notify` to `@/lib/notifications/router` without changing
// anything else. Deliberately identical, not wrapped.
export { notify } from '@/lib/notify';
export type { NotificationParams } from '@/lib/notify';
export * from '@/lib/notifications/catalog';

export type { SkipReason, ChatCard } from '@/lib/notifications/adapters/types';
import type { ChatCard } from '@/lib/notifications/adapters/types';

/**
 * A recipient. Either a bare user id (the router reads what it needs) or a row
 * the caller already has in hand — the fields are exactly the columns any
 * gating decision reads, so passing one saves a query without widening any
 * `select`.
 */
export interface NotifyRecipient {
  id: string;
  role?: NotificationRole | string | null;
  email?: string | null;
  preferredLanguage?: string | null;
  emailNotifications?: boolean | null;
  notificationPrefs?: unknown;
  orgId?: string | null;
  /** IANA zone (#1714): the default zone of the person's quiet hours. */
  timezone?: string | null;
}

export interface NotifyOptions {
  /** Override the event's `defaultChannels` (e.g. force in-app only). */
  channels?: readonly NotificationChannel[];
  /**
   * Stable identity of THIS send, for idempotency. Pass the id of whatever made
   * the notification inevitable — a message id, a relation id plus the day, the
   * job's own idempotency key. Two calls with the same key produce ONE ledger
   * row and one send; without a key every call is a fresh send, which is the
   * right default for an event that genuinely happened twice.
   */
  dedupeKey?: string;
  /** Tenant to stamp when the recipient's own row carries none. */
  orgId?: string | null;
  /**
   * The chat card's subject, link button and supersede intent (#1942). Read by
   * the chat adapter only; the bell and the mail are unchanged by it.
   */
  chatCard?: ChatCard | null;
}

export interface NotifyResult {
  /** Handed to a channel that completed synchronously (in-app). */
  sent: number;
  /** Handed to a channel that completes later (the e-mail job). */
  queued: number;
  /** Suppressed on purpose — an opt-out, a missing address, no adapter. */
  skipped: number;
  /** Already claimed by an identical earlier send: nothing was sent again. */
  deduped: number;
  /** The channel was tried and failed. */
  failed: number;
}

const EMPTY_RESULT = (): NotifyResult => ({ sent: 0, queued: 0, skipped: 0, deduped: 0, failed: 0 });

const KNOWN_ROLES: readonly NotificationRole[] = ['ADMIN', 'MENTOR', 'MENTEE', 'COMPANY', 'SOURCE', 'AFFILIATE'];

function asRole(role: unknown): NotificationRole {
  return KNOWN_ROLES.includes(role as NotificationRole) ? (role as NotificationRole) : 'MENTEE';
}

function asLocale(value: unknown): Locale {
  return isLocale(typeof value === 'string' ? value : undefined) ? (value as Locale) : defaultLocale;
}

/**
 * The stored `dedupeKey`. Always non-null, because a nullable unique column
 * de-duplicates nothing in MySQL (NULLs compare distinct) — the same trap
 * documented on `Job.idempotencyKey`. Without a caller-supplied key the random
 * component makes the row unique, which is "no de-duplication" expressed as a
 * value rather than as a NULL.
 */
function deliveryDedupeKey(
  eventKey: string,
  userId: string,
  channel: NotificationChannel,
  callerKey?: string
): string {
  const scope = callerKey ?? randomUUID();
  return createHash('sha256').update([eventKey, userId, channel, scope].join('\u0000')).digest('hex');
}

// ── The router ───────────────────────────────────────────────────────────────

const RECIPIENT_SELECT = {
  id: true,
  role: true,
  email: true,
  preferredLanguage: true,
  emailNotifications: true,
  notificationPrefs: true,
  orgId: true,
  timezone: true,
} as const;

function needsHydration(r: NotifyRecipient): boolean {
  return r.notificationPrefs === undefined || r.emailNotifications === undefined || r.role === undefined || r.timezone === undefined;
}

async function hydrate(recipients: NotifyRecipient[]): Promise<Map<string, NotifyRecipient>> {
  const known = new Map<string, NotifyRecipient>();
  const missing: string[] = [];
  for (const r of recipients) {
    if (needsHydration(r)) missing.push(r.id);
    else known.set(r.id, r);
  }
  if (missing.length === 0) return known;
  try {
    const rows = await prisma.user.findMany({
      where: { id: { in: missing } },
      select: RECIPIENT_SELECT,
    });
    for (const row of rows) known.set(row.id, row);
  } catch (e) {
    // Degrade to what the caller gave us rather than dropping the notification
    // (the acceptance criterion: a resolution error degrades, it does not
    // silence). An unhydrated recipient keeps its defaults — category ON,
    // e-mail suppressed for want of an address.
    logger.error('Notification recipient resolution failed', {
      count: missing.length,
      error: String(e),
    });
    for (const r of recipients) if (!known.has(r.id)) known.set(r.id, r);
  }
  return known;
}

/**
 * Is this channel allowed for this recipient? The one place the preference
 * axes are combined, and it runs before anything is claimed or sent.
 */
export function channelAllowed(
  def: NotificationEventDef,
  channel: NotificationChannel,
  user: NotifyRecipient
): SkipReason | null {
  // Essential (account_security) mail ignores every switch; so does its in-app
  // twin. See MANDATORY EVENTS at the top of the file.
  if (isEssentialGroup(def.emailGroup)) return channel === 'email' && !user.email ? 'no_address' : null;

  // The category switch outranks everything below it: one /account toggle
  // silences an event on every channel (#886). Then the per-category channel
  // matrix (#1714): a channel the person switched off for this category stays
  // off even when a caller pinned it.
  if (!notificationCategoryAllowed({ notificationPrefs: user.notificationPrefs }, def.category)) return 'category_off';
  if (channelOffInMatrix(readChannelMap(user.notificationPrefs, NOTIFICATION_CATEGORIES), def.category, channel)) return 'channel_off';

  // Push (#1715) answers to the same switches as the bell.
  if (channel === 'inApp' || channel === 'chat' || channel === 'push') return null;

  if (channel === 'email') {
    if (!user.email) return 'no_address';
    if (user.emailNotifications === false) return 'email_off';
    // The e-mail group taxonomy (#1444) is what the footer link and the
    // settings UI actually speak in.
    if (!emailGroupAllowed(user, def.emailGroup)) return 'group_off';
    return null;
  }

  return 'no_adapter';
}

// ── Quiet hours and blackout days (#1714) ───────────────────────────────────

type Blackout = { dates: string[]; weekends: boolean };

/** One settings read per org for a whole fan-out. */
function blackoutMemo(): (orgId: string | null) => Promise<Blackout> {
  const cache = new Map<string, Promise<Blackout>>();
  return (orgId) => {
    if (!orgId) return Promise.resolve({ dates: [], weekends: false });
    let hit = cache.get(orgId);
    if (!hit) {
      hit = Promise.all([resolveSettingRaw('notificationBlackoutDates', { orgId }), resolveSettingRaw('notificationBlackoutWeekends', { orgId })])
        .then(([dates, weekends]) => ({ dates: parseBlackoutDates(dates), weekends: weekends === 'true' }))
        // A settings read that fails holds nothing: an outage must not silence mail.
        .catch(() => ({ dates: [], weekends: false }));
      cache.set(orgId, hit);
    }
    return hit;
  };
}

async function calendarFor(user: NotifyRecipient, orgId: string | null, blackoutOf: (orgId: string | null) => Promise<Blackout>): Promise<Calendar> {
  const quiet = readQuietHours(user.notificationPrefs);
  const tz = quiet?.tz ?? (isValidTimeZone(user.timezone) ? user.timezone : 'UTC');
  const b = await blackoutOf(orgId);
  return { quiet, tz, blackoutDates: b.dates, blackoutWeekends: b.weekends };
}

export interface DeferredDelivery {
  deliveryId: string;
  channel: NotificationChannel;
  eventKey: string;
  userId: string;
  orgId: string | null;
  locale: Locale;
  params: NotificationParams;
  link: string;
  dedupeKey: string;
  card?: ChatCard | null;
}

/** Hold one claimed delivery until `openAt`. Keyed per delivery: held once, sent once. */
async function deferDelivery(d: DeferredDelivery, openAt: Date): Promise<boolean> {
  try {
    await enqueue('notification.deferred', d, {
      store: prismaQueueStore(),
      orgId: d.orgId,
      runAt: openAt,
      idempotencyKey: `notify-deferred:${d.dedupeKey}`,
      trigger: 'event',
    });
    return true;
  } catch (e) {
    logger.error('Failed to hold a notification for quiet hours', { eventKey: d.eventKey, error: String(e) });
    return false;
  }
}

/**
 * The `notification.deferred` job (registered in src/jobs/index.ts): deliver a
 * held delivery when its window opens. The person's preferences are read AGAIN
 * — a channel switched off overnight stays off — and the ledger row is settled
 * exactly like an immediate delivery. Rerun-safe: a row no longer QUEUED was
 * settled by an earlier run and is left alone.
 */
export async function runDeferredDelivery(d: DeferredDelivery): Promise<'sent' | 'queued' | 'skipped' | 'failed' | 'gone'> {
  const def = eventDef(d.eventKey as NotificationEventKey);
  const row = await prisma.notificationDelivery.findUnique({ where: { id: d.deliveryId }, select: { status: true } });
  if (!def || !row || row.status !== 'QUEUED') return 'gone';
  const user = await prisma.user.findUnique({ where: { id: d.userId }, select: RECIPIENT_SELECT });
  if (!user) {
    await settleDelivery(d.deliveryId, 'SKIPPED', { skipReason: 'no_address' });
    return 'skipped';
  }
  const skip = channelAllowed(def, d.channel, user);
  if (skip) {
    await settleDelivery(d.deliveryId, 'SKIPPED', { skipReason: skip });
    return 'skipped';
  }
  const adapter = CHANNEL_ADAPTERS[d.channel];
  const outcome = await adapter
    .deliver({ deliveryId: d.deliveryId, def, userId: d.userId, orgId: d.orgId, locale: d.locale, params: d.params, link: d.link, dedupeKey: d.dedupeKey, card: d.card ?? null })
    .catch((e: unknown) => ({ status: 'FAILED' as const, error: String(e) }));
  const templateId = `notifications.events.${def.key}`;
  if (outcome.status === 'SENT') {
    await settleDelivery(d.deliveryId, 'SENT', { templateId });
    return 'sent';
  }
  if (outcome.status === 'QUEUED') return 'queued';
  if (outcome.status === 'SKIPPED') {
    await settleDelivery(d.deliveryId, 'SKIPPED', { skipReason: outcome.reason });
    return 'skipped';
  }
  await settleDelivery(d.deliveryId, 'FAILED', { error: outcome.error });
  return 'failed';
}

/**
 * Tell people something happened.
 *
 * ```ts
 * await notifyEvent(mentorId, 'deadline.stagePassed', { menteeName, relationId });
 * ```
 *
 * Only a key from the catalogue compiles, and only a payload carrying every
 * placeholder its dictionary template interpolates. Never throws.
 */
export async function notifyEvent<K extends NotificationEventKey>(
  recipients: string | NotifyRecipient | readonly (string | NotifyRecipient)[],
  eventKey: K,
  payload: EventPayload<K>,
  opts?: NotifyOptions
): Promise<NotifyResult> {
  const result = EMPTY_RESULT();
  try {
    const def = eventDef(eventKey);
    if (!def) {
      // Unreachable through the types; reachable from JavaScript, and from a
      // key that was deleted from the catalogue while a queued job still names
      // it. Logged, never thrown.
      logger.error('notifyEvent called with an unknown event key', { eventKey: String(eventKey) });
      return result;
    }

    const list = (Array.isArray(recipients) ? recipients : [recipients]) as readonly (
      | string
      | NotifyRecipient
    )[];
    const normalized: NotifyRecipient[] = [];
    const seen = new Set<string>();
    for (const r of list) {
      const rec: NotifyRecipient = typeof r === 'string' ? { id: r } : r;
      if (!rec?.id || seen.has(rec.id)) continue;
      seen.add(rec.id);
      normalized.push(rec);
    }
    if (normalized.length === 0) return result;

    const channels = opts?.channels ?? def.defaultChannels;

    const check = validateEventPayload(def.key, payload);
    if (!check.ok) {
      // A missing placeholder renders as a literal "{menteeName}" in somebody's
      // bell. Better to record why nobody was told than to send that.
      //
      // Recorded per channel, exactly like a preference skip, so the ledger
      // answers "was this person told?" with the same number of rows whatever
      // went wrong — an operator counting rows per (event, channel) should not
      // have to know that one class of failure writes fewer of them.
      logger.error('notifyEvent payload is missing required params', {
        eventKey: def.key,
        missing: check.missing,
      });
      for (const rec of normalized) {
        for (const channel of channels) {
          result.skipped += 1;
          await recordSkipped(
            {
              orgId: rec.orgId ?? opts?.orgId ?? null,
              userId: rec.id,
              eventKey: def.key,
              channel,
              dedupeKey: deliveryDedupeKey(def.key, rec.id, channel, opts?.dedupeKey),
            },
            'invalid_payload'
          );
        }
      }
      return result;
    }

    const hydrated = await hydrate(normalized);

    // Only the declared placeholders travel into `Notification.params`; the
    // link ids are consumed by notificationLink() and are not interpolation
    // values. Anything else the caller passed is dropped rather than stored.
    const raw = payload as Record<string, unknown>;
    const params: NotificationParams = {};
    for (const p of def.params) {
      const v = raw[p];
      if (typeof v === 'string' || typeof v === 'number') params[p] = v;
    }
    const linkIds: Record<string, string | undefined> = {};
    for (const k of LINK_ID_KEYS) {
      const v = raw[k];
      if (typeof v === 'string') linkIds[k] = v;
    }

    // Chat (#1939) rides along for the people who linked a chat identity —
    // unless the caller pinned the channels explicitly (a security notice that
    // asks for in-app only gets in-app only).
    const chatUsers = opts?.channels ? new Set<string>() : await chatCapableUsers(normalized.map((r) => r.id));

    // The recipient's vertical shapes the deep link (a MARKETING rep's record
    // is /sales/leads/<id>, #2580); one lookup per org for the whole fan-out.
    const capabilitiesOf = capabilitiesMemo();
    const blackoutOf = blackoutMemo();
    for (const rec of normalized) {
      const user = hydrated.get(rec.id) ?? rec;
      const orgId = user.orgId ?? rec.orgId ?? opts?.orgId ?? null;
      const locale = asLocale(user.preferredLanguage);
      const link = notificationLink(asRole(user.role), def.link, linkIds, { capabilities: await capabilitiesOf(orgId) });

      // The person's channel matrix (#1714) can add push to the defaults; a
      // channel they switched off is recorded as skipped by channelAllowed. A
      // caller that pinned channels keeps them, and essential events ignore it.
      const base: readonly NotificationChannel[] =
        opts?.channels || isEssentialGroup(def.emailGroup)
          ? channels
          : resolveChannels(readChannelMap(user.notificationPrefs, NOTIFICATION_CATEGORIES), def.category, channels);
      const recipientChannels: readonly NotificationChannel[] =
        chatUsers.has(rec.id) && !base.includes('chat') ? [...base, 'chat'] : base;
      for (const channel of recipientChannels) {
        const row: LedgerRow = {
          orgId,
          userId: rec.id,
          eventKey: def.key,
          channel,
          dedupeKey: deliveryDedupeKey(def.key, rec.id, channel, opts?.dedupeKey),
        };

        // PREFERENCE FIRST, CLAIM SECOND. See the header note.
        const skip = channelAllowed(def, channel, user);
        if (skip) {
          result.skipped += 1;
          await recordSkipped(row, skip);
          continue;
        }

        const deliveryId = await claimDelivery(row);
        if (!deliveryId) {
          result.deduped += 1;
          continue;
        }

        // Quiet hours and org blackout days (#1714): an interrupting channel is
        // HELD to the next open instant, never dropped — a keyed deferred job,
        // the ledger row QUEUED meanwhile. The bell and essential events go now.
        if (DEFERRABLE_CHANNELS.includes(channel) && !isEssentialGroup(def.emailGroup)) {
          const openAt = nextOpenInstant(new Date(), await calendarFor(user, orgId, blackoutOf));
          if (openAt) {
            const held = await deferDelivery({ deliveryId, channel, eventKey: def.key, userId: rec.id, orgId, locale, params, link, dedupeKey: row.dedupeKey, card: opts?.chatCard ?? null }, openAt);
            if (held) {
              result.queued += 1;
              await settleDelivery(deliveryId, 'QUEUED', { templateId: `notifications.events.${def.key}` });
            } else {
              result.failed += 1;
              await settleDelivery(deliveryId, 'FAILED', { error: 'could not hold for quiet hours' });
            }
            continue;
          }
        }

        // The channel's own adapter performs it (#1711, ./adapters): the router
        // has decided and claimed; the adapter only knows how to deliver.
        const adapter = CHANNEL_ADAPTERS[channel];
        if (!adapter || !adapter.available()) {
          result.skipped += 1;
          await settleDelivery(deliveryId, 'SKIPPED', { skipReason: 'no_adapter' });
          continue;
        }
        const outcome = await adapter
          .deliver({ deliveryId, def, userId: rec.id, orgId, locale, params, link, dedupeKey: row.dedupeKey, card: opts?.chatCard ?? null })
          .catch((e: unknown) => ({ status: 'FAILED' as const, error: String(e) }));
        const templateId = `notifications.events.${def.key}`;
        if (outcome.status === 'SENT') {
          result.sent += 1;
          await settleDelivery(deliveryId, 'SENT', { templateId });
        } else if (outcome.status === 'QUEUED') {
          // Stays QUEUED: the worker that performs it settles the row.
          result.queued += 1;
          await settleDelivery(deliveryId, 'QUEUED', { templateId });
        } else if (outcome.status === 'SKIPPED') {
          result.skipped += 1;
          await settleDelivery(deliveryId, 'SKIPPED', { skipReason: outcome.reason });
        } else {
          result.failed += 1;
          await settleDelivery(deliveryId, 'FAILED', { error: outcome.error });
        }
      }
    }
  } catch (e) {
    // The outermost net. Nothing below is expected to throw; if something does,
    // the caller's own work still stands.
    logger.error('notifyEvent failed', { eventKey: String(eventKey), error: String(e) });
  }
  return result;
}

/**
 * Re-send ONE failed chat delivery (#1960, the "Retry" button of the ledger on
 * /admin/integrations) — through the router, never straight at the platform:
 * it claims its own ledger row (keyed on the failed attempt, so a double click
 * is one retry) and hands the chat adapter the same sentence and link the
 * original notification carried. The adapter writes a NEW ChatDelivery row;
 * the failed one is never rewritten (the ledger is append-only).
 *
 * The params and link come from the person's in-app notification of that event
 * — the one place they are kept — so a retry is impossible once that row is
 * gone (`source_gone`), rather than a guess at what the card said.
 */
export async function retryChatDelivery(input: {
  failedDeliveryId: string;
  userId: string;
  orgId: string | null;
  eventKey: string;
  params: NotificationParams;
  link: string;
  locale: Locale;
}): Promise<{ status: 'SENT' | 'SKIPPED' | 'FAILED' | 'DUPLICATE'; error?: string }> {
  const def = eventDef(input.eventKey as NotificationEventKey);
  const row: LedgerRow = {
    orgId: input.orgId,
    userId: input.userId,
    eventKey: input.eventKey,
    channel: 'chat',
    dedupeKey: deliveryDedupeKey(input.eventKey, input.userId, 'chat', `retry:${input.failedDeliveryId}`),
  };
  const deliveryId = await claimDelivery(row);
  if (!deliveryId) return { status: 'DUPLICATE' };
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(input.params ?? {})) if (typeof v === 'string' || typeof v === 'number') params[k] = v;
  const outcome = await deliverChat({ userId: input.userId, orgId: input.orgId, eventKey: input.eventKey, params, link: input.link, locale: input.locale });
  const templateId = def ? `notifications.events.${def.key}` : undefined;
  if (outcome.status === 'SENT') await settleDelivery(deliveryId, 'SENT', { templateId });
  else if (outcome.status === 'SKIPPED') await settleDelivery(deliveryId, 'SKIPPED', { skipReason: outcome.reason });
  else await settleDelivery(deliveryId, 'FAILED', { error: outcome.error });
  return outcome.status === 'FAILED' ? { status: 'FAILED', error: outcome.error } : { status: outcome.status };
}

