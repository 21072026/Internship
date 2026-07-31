import { prisma } from '@/lib/prisma';
import { logger, type LogLevel } from '@/lib/logger';
import { clientIp, type HeaderSource } from '@/lib/clientIp';

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
