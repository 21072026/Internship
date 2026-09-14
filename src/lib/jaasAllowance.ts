import { createHmac } from 'crypto';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { jaasConfig } from '@/lib/jaas';
import { currentPeriod, type Period } from '@/lib/meteringRules';

// The JaaS monthly-active-participant allowance — counted by us, from our own
// data (#2011).
//
// The problem this solves: 8x8 caps a free JaaS tenant at a number of DISTINCT
// participants per calendar month, and until now that number lived only in the
// provider's dashboard. So the routing rule in lib/meetingRoom.ts ("1:1 calls
// get the tenant, everything else gets the public instance") was a guess at
// protecting an allowance nobody in this codebase could measure — and the price
// of that guess was paid by every group call, on a public instance that hangs
// up an EMBEDDED call after about five minutes.
//
// The JaaS webhook feed already delivers PARTICIPANT_JOINED with a participant
// id. Writing one row per (month, participant) turns "how much of the allowance
// have we used?" into a COUNT. With a number, the routing can stop guessing:
// a group room may use the tenant while the projected head-count still fits,
// and the moment it does not, the room degrades to the public instance WITH the
// warning rather than quietly overspending or failing to start.
//
// Server-only (node:crypto + Prisma). The client-side half of the honesty — the
// warning itself — needs none of this and lives in lib/meetingLink.ts.

// ── The allowance, as configuration ─────────────────────────────────────────
// 25 is 8x8's free-tier figure at the time of writing, and it is a number they
// change without asking us. It is therefore an env var with a documented
// default rather than a literal in a component: an operator who moves to a paid
// tier raises one variable, redeploys, and every routing decision below follows
// — no code change, no re-reading of this file.

/** The free tier's figure, and the default when nothing is configured. */
export const DEFAULT_JAAS_MAU_ALLOWANCE = 25;

/**
 * The tenant's monthly distinct-participant allowance.
 *
 * `0` is a meaningful value and is honoured: it means "never route to JaaS",
 * a kill switch an operator can pull without unsetting credentials that other
 * things (the webhook feed, an in-flight call's tokens) still need. A negative
 * or non-numeric value is nonsense and falls back to the default rather than
 * silently disabling video routing.
 */
export function jaasMauAllowance(): number {
  const raw = process.env.JAAS_MONTHLY_ACTIVE_LIMIT?.trim();
  if (!raw) return DEFAULT_JAAS_MAU_ALLOWANCE;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_JAAS_MAU_ALLOWANCE;
  return Math.floor(parsed);
}

/**
 * The head-count assumed for a room whose audience is not known yet.
 *
 * A recurring series is created before anybody is in it: its audience is
 * derived from membership later and grows over time, so `inviteeCount` is
 * genuinely `null` rather than zero. Booking it against the allowance as if it
 * were a pair would understate it every time; booking it as if it were the
 * whole organisation would keep every series off the tenant forever, which is
 * exactly the bug this task exists to fix. A small group is the honest middle,
 * and being wrong in either direction only shifts *which host* a room gets —
 * never whether the call happens.
 */
export const UNKNOWN_AUDIENCE_HEAD_COUNT = 5;

/**
 * How many people a room is expected to put on the tenant: the invitees plus
 * the organiser, who is never in the invitee list.
 */
export function projectedHeadCount(inviteeCount: number | null | undefined): number {
  if (inviteeCount === null || inviteeCount === undefined) return UNKNOWN_AUDIENCE_HEAD_COUNT;
  return Math.max(1, inviteeCount) + 1;
}

/**
 * The arithmetic, on its own so it can be reasoned about (and tested) without a
 * database: does a room of `headCount` people still fit inside the allowance?
 *
 * Pessimistic on purpose — it assumes every head is a participant we have not
 * already counted this month. In practice a mentor is in twenty calls and
 * counts once, so real usage is lower than this projection; erring that way
 * means we degrade to the public instance slightly early instead of discovering
 * the ceiling by having a call refused by 8x8 mid-meeting.
 */
export function fitsAllowance(active: number, headCount: number, allowance: number): boolean {
  return active + headCount <= allowance;
}

// ── Counting ────────────────────────────────────────────────────────────────

/**
 * The keyed hash a participant is stored as.
 *
 * HMAC rather than a bare SHA-256: a JaaS participant id is short and
 * structured, so an unkeyed digest of one is reversible by anyone who can
 * enumerate the space. The key is the deployment's own secret, which also means
 * two deployments hash the same person to different values and the table cannot
 * be correlated across them.
 *
 * `NEXTAUTH_SECRET` is required for the app to run at all, so this never has to
 * cope with an absent key in a real deployment; the literal below only keeps a
 * misconfigured local box from throwing inside a webhook.
 */
export function hashParticipantId(participantId: string): string {
  const key = process.env.NEXTAUTH_SECRET?.trim() || 'jaas-usage-unconfigured';
  return createHmac('sha256', key).update(`jaas:${participantId}`).digest('hex');
}

/**
 * Record that a participant was active this month. Idempotent: the second time
 * the same person joins a room in the same month the upsert is a no-op, which
 * is what makes the row count a distinct count.
 *
 * Never throws — a meter must not be able to fail an inbound event, because a
 * webhook that errors gets retried and eventually disabled by the provider, and
 * then we lose the live "n in the call" line too.
 */
export async function recordJaasParticipant(participantId: string, at: Date = new Date()): Promise<void> {
  const id = participantId.trim();
  if (!id) return;
  const period = currentPeriod(at);
  const participantHash = hashParticipantId(id);
  try {
    await prisma.jaasMonthlyParticipant.upsert({
      where: { period_participantHash: { period, participantHash } },
      create: { period, participantHash, firstSeenAt: at },
      // Nothing to update — the row's whole content is its existence. `period`
      // is written back to itself so Prisma has a non-empty update payload.
      update: { period },
    });
  } catch (e) {
    logger.warning('JaaS monthly participant not recorded', { period, error: String(e) });
  }
}

/** Distinct participants seen on the tenant in a calendar month. */
export async function countMonthlyActiveParticipants(period: Period = currentPeriod()): Promise<number> {
  return prisma.jaasMonthlyParticipant.count({ where: { period } });
}

export interface JaasAllowanceStatus {
  /** Whether the tenant is configured at all (all three JAAS_* vars). */
  configured: boolean;
  /** Whether the webhook feed that produces the count is configured. */
  metered: boolean;
  /** 'YYYY-MM', UTC. */
  period: Period;
  /** Distinct participants counted so far this month. */
  active: number;
  allowance: number;
  /** Participants left before new rooms stop being routed to the tenant. */
  remaining: number;
}

/**
 * The operator-facing figure: "18 / 25 monthly active participants".
 *
 * Reported, never charged to anybody. This exists so a human can decide whether
 * to buy a paid tier from evidence instead of from the guess the old routing
 * rule encoded — see docs/video-calls-jaas.md.
 */
export async function jaasAllowanceStatus(period: Period = currentPeriod()): Promise<JaasAllowanceStatus> {
  const allowance = jaasMauAllowance();
  const active = await countMonthlyActiveParticipants(period).catch(() => 0);
  return {
    configured: jaasConfig() !== null,
    metered: !!process.env.JAAS_WEBHOOK_SECRET?.trim(),
    period,
    active,
    allowance,
    remaining: Math.max(0, allowance - active),
  };
}

/**
 * May a new room of `headCount` people be created on the JaaS tenant?
 *
 * The short-circuit matters: with no tenant configured — local dev, CI, every
 * e2e run, an un-provisioned deployment — this answers `false` without touching
 * the database, so room creation costs exactly what it costs today.
 *
 * When the tenant IS configured but the webhook feed is not, the count stays at
 * zero and every room is routed to the tenant. That is deliberate: an operator
 * who has not wired the feed has given us no evidence of exhaustion, and
 * inventing one would push working calls onto a host that cuts them off after
 * five minutes. The admin card says the count is unmetered, so the zero is not
 * mistaken for "we have used nothing".
 *
 * Never throws. A database that cannot answer must not be able to stop a
 * meeting from being created — it only means the room is a public one, which is
 * still a room that works.
 */
export async function jaasRoomAllowed(headCount: number): Promise<boolean> {
  if (jaasConfig() === null) return false;
  const allowance = jaasMauAllowance();
  if (allowance <= 0) return false;
  try {
    const active = await countMonthlyActiveParticipants();
    return fitsAllowance(active, headCount, allowance);
  } catch (e) {
    logger.warning('JaaS allowance not readable — routing to the public instance', { error: String(e) });
    return false;
  }
}
