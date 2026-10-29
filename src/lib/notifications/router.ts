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
import type { Prisma } from '@prisma/client';
import { notify as notifyInApp, type NotificationParams } from '@/lib/notify';
import { notificationCategoryAllowed } from '@/lib/notificationPrefs';
import { emailGroupAllowed, isEssentialGroup } from '@/lib/emailGroups';
import { notificationLink, type NotificationRole } from '@/lib/notificationLink';
import { capabilitiesMemo } from '@/lib/shellCapabilities';
import { chatCapableUsers, deliverChat } from '@/lib/notifications/adapters/chat';
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

// ── The ledger ───────────────────────────────────────────────────────────────

interface LedgerRow {
  orgId: string | null;
  userId: string;
  eventKey: string;
  channel: NotificationChannel;
  dedupeKey: string;
}

/**
 * Record a delivery that will not be attempted. Written with the same dedupe
 * key the send would have used, so a repeat of the same suppressed send does
 * not pile up rows — and so an operator reading the ledger sees one line per
 * (person, event, channel) whatever happened to it.
 */
async function recordSkipped(row: LedgerRow, reason: SkipReason): Promise<void> {
  try {
    await prisma.notificationDelivery.create({
      data: { ...row, status: 'SKIPPED', skipReason: reason },
    });
  } catch (e) {
    // A duplicate here means the same suppressed send was already recorded:
    // that is the idempotency working, not a failure worth logging loudly.
    if (!isUniqueViolation(e)) {
      logger.error('Failed to record skipped notification delivery', {
        userId: row.userId,
        eventKey: row.eventKey,
        channel: row.channel,
        error: String(e),
      });
    }
  }
}

/**
 * Claim the right to send. Returns the row id when this call created it, and
 * `null` when an identical send already exists (or the ledger write failed —
 * see below).
 *
 * A failed claim FAILS CLOSED. If the ledger is unwritable we do not send: a
 * send whose record was lost is exactly the "did anybody actually tell them?"
 * hole this ledger exists to close, and a retry would have no way to know the
 * first attempt happened. The caller's own work has already committed either
 * way, so nothing is rolled back by declining to notify.
 */
async function claimDelivery(row: LedgerRow): Promise<string | null> {
  try {
    const created = await prisma.notificationDelivery.create({ data: { ...row, status: 'QUEUED' } });
    return created.id;
  } catch (e) {
    if (!isUniqueViolation(e)) {
      logger.error('Failed to claim notification delivery', {
        userId: row.userId,
        eventKey: row.eventKey,
        channel: row.channel,
        error: String(e),
      });
    }
    return null;
  }
}

async function settleDelivery(
  id: string,
  status: 'SENT' | 'FAILED' | 'QUEUED' | 'SKIPPED',
  extra?: { error?: string; templateId?: string; skipReason?: SkipReason }
): Promise<void> {
  try {
    await prisma.notificationDelivery.update({
      where: { id },
      data: {
        status,
        error: extra?.error?.slice(0, 2000) ?? null,
        templateId: extra?.templateId ?? null,
        skipReason: extra?.skipReason ?? null,
      },
    });
  } catch (e) {
    logger.error('Failed to settle notification delivery', { id, status, error: String(e) });
  }
}

function isUniqueViolation(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: string }).code === 'P2002';
}

// ── Channels ─────────────────────────────────────────────────────────────────

interface DeliveryContext {
  def: NotificationEventDef;
  recipient: Required<Pick<NotifyRecipient, 'id'>> & NotifyRecipient;
  locale: Locale;
  params: NotificationParams;
  link: string;
  orgId: string | null;
  dedupeKey: string;
}

/**
 * The e-mail channel. It does NOT send: it enqueues, so a slow or dead SMTP
 * server can never sit inside the request that triggered the notification, and
 * a transient failure is retried by the worker instead of being lost.
 *
 * The insert is written against the `Job` table directly because the queue's
 * own `enqueue()` helper (#1671) is not in the tree yet — only the model, the
 * health counters and the dead-letter alert are. The shape is deliberately the
 * one `enqueue({ name, payload, idempotencyKey, orgId })` will take, so the day
 * that helper lands this function becomes a one-line call to it. The handler
 * that renders and sends the mail arrives with the worker; until then a row
 * here is a durable "this person is owed an e-mail", which is strictly more
 * than the nothing that was recorded before.
 *
 * WORLDS (#2590). `link` is stored RELATIVE ("/messages/…") and must stay so: it
 * is a path inside the recipient's product, not an address. Whoever renders the
 * queued mail (the worker handler this row is waiting for) must build the
 * absolute URL PER RECIPIENT from the recipient's own organization —
 * `appUrlFor(orgId)` in services/emailService.ts, the same resolver every other
 * mail uses — and never from NEXT_PUBLIC_APP_URL directly, or a marketing
 * account's notification mail opens the internship host. The row carries what
 * that needs: `userId` in the payload and `orgId` on the job itself.
 */
async function enqueueEmail(ctx: DeliveryContext): Promise<{ ok: boolean; error?: string }> {
  try {
    await prisma.job.create({
      data: {
        name: 'notification.email',
        payload: {
          eventKey: ctx.def.key,
          userId: ctx.recipient.id,
          locale: ctx.locale,
          params: ctx.params,
          link: ctx.link,
          emailGroup: ctx.def.emailGroup,
          delivery: ctx.def.delivery,
        } as Prisma.InputJsonValue,
        // Prefixed so the notification namespace can never collide with another
        // producer's key on the globally-unique column.
        idempotencyKey: `notify:${ctx.dedupeKey}`,
        orgId: ctx.orgId,
      },
    });
    return { ok: true };
  } catch (e) {
    // A duplicate job for a delivery we just claimed means a previous attempt
    // enqueued it and then failed before settling the ledger row. The mail is
    // already owed exactly once, so this is a success, not a failure.
    if (isUniqueViolation(e)) return { ok: true };
    return { ok: false, error: String(e) };
  }
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
} as const;

function needsHydration(r: NotifyRecipient): boolean {
  return r.notificationPrefs === undefined || r.emailNotifications === undefined || r.role === undefined;
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
function channelAllowed(
  def: NotificationEventDef,
  channel: NotificationChannel,
  user: NotifyRecipient
): SkipReason | null {
  // Essential (account_security) mail ignores every switch; so does its in-app
  // twin. See MANDATORY EVENTS at the top of the file.
  if (isEssentialGroup(def.emailGroup)) return channel === 'email' && !user.email ? 'no_address' : null;

  if (channel === 'inApp' || channel === 'chat') {
    return notificationCategoryAllowed({ notificationPrefs: user.notificationPrefs }, def.category)
      ? null
      : 'category_off';
  }

  if (channel === 'email') {
    if (!user.email) return 'no_address';
    if (user.emailNotifications === false) return 'email_off';
    // Both axes, in the order a reader would expect them to apply: the coarse
    // in-app category switch still means what it always meant (#886), and the
    // e-mail group taxonomy (#1444) is what the footer link and the settings UI
    // actually speak in.
    if (!notificationCategoryAllowed({ notificationPrefs: user.notificationPrefs }, def.category)) {
      return 'category_off';
    }
    if (!emailGroupAllowed(user, def.emailGroup)) return 'group_off';
    return null;
  }

  return 'no_adapter';
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
    for (const rec of normalized) {
      const user = hydrated.get(rec.id) ?? rec;
      const orgId = user.orgId ?? rec.orgId ?? opts?.orgId ?? null;
      const locale = asLocale(user.preferredLanguage);
      const link = notificationLink(asRole(user.role), def.link, linkIds, { capabilities: await capabilitiesOf(orgId) });

      const recipientChannels: readonly NotificationChannel[] =
        chatUsers.has(rec.id) && !channels.includes('chat') ? [...channels, 'chat'] : channels;
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

        const ctx: DeliveryContext = { def, recipient: user, locale, params, link, orgId, dedupeKey: row.dedupeKey };

        if (channel === 'inApp') {
          // notify() swallows its own errors, so "it returned" is all the
          // certainty there is here — the same certainty every existing call
          // site has had, now at least written down.
          await notifyInApp(rec.id, def.key, params, link);
          result.sent += 1;
          await settleDelivery(deliveryId, 'SENT', { templateId: `notifications.events.${def.key}` });
          continue;
        }

        if (channel === 'email') {
          const outcome = await enqueueEmail(ctx);
          if (outcome.ok) {
            result.queued += 1;
            // Stays QUEUED: the job, not this function, decides whether the
            // mail was actually handed to SMTP.
            await settleDelivery(deliveryId, 'QUEUED', { templateId: `notifications.events.${def.key}` });
          } else {
            result.failed += 1;
            await settleDelivery(deliveryId, 'FAILED', { error: outcome.error });
          }
          continue;
        }

        if (channel === 'chat') {
          // Its own ledger row and its own outcome: a disabled or failing
          // workspace never touches the e-mail or in-app delivery above.
          const outcome = await deliverChat({ userId: rec.id, orgId, eventKey: def.key, params, link, locale });
          if (outcome.status === 'SENT') {
            result.sent += 1;
            await settleDelivery(deliveryId, 'SENT', { templateId: `notifications.events.${def.key}` });
          } else if (outcome.status === 'SKIPPED') {
            result.skipped += 1;
            await settleDelivery(deliveryId, 'SKIPPED', { skipReason: outcome.reason });
          } else {
            result.failed += 1;
            await settleDelivery(deliveryId, 'FAILED', { error: outcome.error });
          }
          continue;
        }

        result.skipped += 1;
        await settleDelivery(deliveryId, 'SKIPPED', { skipReason: 'no_adapter' });
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

