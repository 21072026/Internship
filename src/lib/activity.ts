import { prisma } from '@/lib/prisma';
import { logger, type LogLevel } from '@/lib/logger';
import { clientIp, type HeaderSource } from '@/lib/clientIp';
import { getSetting } from '@/lib/settings';
import { parseViewLogWindowMinutes, recordViewOnce, type ViewLogOutcome } from '@/lib/viewLogRule';

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
    await prisma.activityLog.create({
      data: {
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

export interface ViewActivityInput extends ActivityInput {
  actorId: string;
  targetType: string;
  targetId: string;
}

/**
 * Record that `actorId` READ a record, at most once per window (#2433).
 *
 * The same `logActivity()` write as every other entry, behind a repeat check:
 * an identical entry (same action, actor, target, detail and origin IP) newer
 * than `viewLogWindowMinutes` suppresses this one. The rule, and why each
 * failure falls the way it does, is in src/lib/viewLogRule.ts. Never throws.
 *
 * Call it inside the request's tenant scope, so the window is read from that
 * org's settings row before the global one.
 */
export async function logViewActivity(input: ViewActivityInput): Promise<ViewLogOutcome> {
  return recordViewOnce({
    windowMinutes: async () => parseViewLogWindowMinutes(await getSetting('viewLogWindowMinutes')),
    hasRecent: async (since) => {
      const recent = await prisma.activityLog.findFirst({
        where: {
          action: input.action,
          actorId: input.actorId,
          targetType: input.targetType,
          targetId: input.targetId,
          detail: input.detail ?? null,
          // The same value logActivity() will store, so "same origin" compares
          // like with like. A read without a request has no origin (null).
          ip: input.request ? clientIp(input.request) : null,
          createdAt: { gte: since },
        },
        select: { id: true },
      });
      return recent !== null;
    },
    write: () => logActivity(input),
  });
}
