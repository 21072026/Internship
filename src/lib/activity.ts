import { prisma } from '@/lib/prisma';
import { logger, type LogLevel } from '@/lib/logger';
import { clientIp, type HeaderSource } from '@/lib/clientIp';
import { getSetting } from '@/lib/settings';
import { pickActivityOrg, USER_TARGET_TYPES } from '@/lib/activityOrgRule';
import {
  attributeView,
  parseViewLogWindowMinutes,
  recordViewOnce,
  type ViewLogOutcome,
  type ViewReader,
} from '@/lib/viewLogRule';

type Level = LogLevel; // 'debug' | 'info' | 'warning' | 'error'
const LEVEL_DB = { debug: 'DEBUG', info: 'INFO', warning: 'WARNING', error: 'ERROR' } as const;

// A user-agent string is attacker-controlled free text; cap it so a long one
// can't bloat the row (the column is TEXT, but there is no reason to store 8 KB).
const UA_MAX = 512;

export interface ActivityInput {
  action: string;
  level?: Level;
  actorId?: string | null;
  actorEmail?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  detail?: string | null;
  /**
   * The request behind the action, when the call site has one (#881). Its IP
   * and user-agent are recorded so an incident review can ask "was this really
   * the user?" — actor + action alone cannot answer that. Optional: cron jobs
   * and NextAuth's event callbacks have no Request, and those entries simply
   * carry no origin.
   */
  request?: HeaderSource | null;
  /**
   * The tenant the entry belongs to, when the call site knows it better than
   * the actor does (cross-world isolation). Omitted, it is resolved from the
   * actor's org, then the target user's — see src/lib/activityOrgRule.ts.
   */
  orgId?: string | null;
}

// The org of one user id, or null. A failed lookup is null too: the entry is
// still written, it just reads as the default org's.
async function orgOfUser(userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  try {
    const row = await prisma.user.findUnique({ where: { id: userId }, select: { orgId: true } });
    return row?.orgId ?? null;
  } catch {
    return null;
  }
}

/** The org logActivity() stamps on an entry — exported for the 2FA-reset transaction. */
export async function resolveActivityOrg(input: Pick<ActivityInput, 'orgId' | 'actorId' | 'targetType' | 'targetId'>): Promise<string | null> {
  if (input.orgId) return input.orgId;
  const actorOrgId = await orgOfUser(input.actorId);
  const targetUserOrgId =
    !actorOrgId && input.targetType && USER_TARGET_TYPES.includes(input.targetType)
      ? await orgOfUser(input.targetId)
      : null;
  return pickActivityOrg({ explicitOrgId: input.orgId, actorOrgId, targetType: input.targetType, targetUserOrgId });
}

// Record an activity entry (and mirror it to the structured logger). Never
// throws — logging must not break the request it describes.
export async function logActivity(input: ActivityInput): Promise<void> {
  const level = input.level || 'info';
  logger[level](input.action, {
    actorId: input.actorId ?? undefined,
    targetType: input.targetType ?? undefined,
    targetId: input.targetId ?? undefined,
    detail: input.detail ?? undefined,
  });
  const req = input.request;
  try {
    const orgId = await resolveActivityOrg(input);
    await prisma.activityLog.create({
      data: {
        // Left undefined (not null) when nothing resolved, so a bound tenant
        // scope can still fill it in once isolation is enforced.
        ...(orgId ? { orgId } : {}),
        action: input.action,
        level: LEVEL_DB[level],
        actorId: input.actorId ?? null,
        actorEmail: input.actorEmail ?? null,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        detail: input.detail ?? null,
        ip: req ? clientIp(req) : null,
        userAgent: req ? (req.headers.get('user-agent') || '').slice(0, UA_MAX) || null : null,
      },
    });
  } catch (e) {
    logger.error('Failed to persist activity log', { action: input.action, error: String(e) });
  }
}

export interface ViewActivityInput {
  action: string;
  /** The session user. Who the entry names as actor is attributeView()'s call. */
  reader: ViewReader;
  targetType: string;
  targetId: string;
  request?: HeaderSource | null;
}

/**
 * Record that someone READ a record, at most once per window (#2433).
 *
 * The same `logActivity()` write as every other entry, behind a repeat check:
 * an identical entry (same action, actor, target, detail and origin IP) newer
 * than `viewLogWindowMinutes` suppresses this one. The entry is attributed to
 * the real reader, the admin behind an impersonated session included, and
 * carries no record name. The rule, and why each failure path falls the way
 * it does, is in src/lib/viewLogRule.ts. Never throws.
 *
 * Call it inside the request's tenant scope, so the window is read from that
 * org's settings row before the global one.
 */
export async function logViewActivity(input: ViewActivityInput): Promise<ViewLogOutcome> {
  const { reader, action, targetType, targetId, request } = input;

  // Only an impersonated read needs a lookup: the session carries the user's
  // e-mail, not the admin's. Impersonation never crosses an org (it is started
  // inside the admin's tenant scope), so the scope the caller runs in reaches
  // the admin's row. A failed lookup still attributes the read to the admin's id.
  let impersonatorEmail: string | null = null;
  if (reader.impersonatorId) {
    try {
      const admin = await prisma.user.findUnique({ where: { id: reader.impersonatorId }, select: { email: true } });
      impersonatorEmail = admin?.email ?? null;
    } catch {
      /* the id alone still names the real reader */
    }
  }
  const { actorId, actorEmail, detail } = attributeView(reader, impersonatorEmail);
  const entry: ActivityInput = { action, actorId, actorEmail, targetType, targetId, detail, request };

  return recordViewOnce({
    windowMinutes: async () => parseViewLogWindowMinutes(await getSetting('viewLogWindowMinutes')),
    hasRecent: async (since) => {
      const recent = await prisma.activityLog.findFirst({
        where: {
          action,
          actorId,
          targetType,
          targetId,
          detail,
          // The same value logActivity() will store, so "same origin" compares
          // like with like. A read without a request has no origin (null).
          ip: request ? clientIp(request) : null,
          createdAt: { gte: since },
        },
        select: { id: true },
      });
      return recent !== null;
    },
    write: () => logActivity(entry),
  });
}
