import { prisma } from '@/lib/prisma';
import { logger, type LogLevel } from '@/lib/logger';

type Level = LogLevel; // 'debug' | 'info' | 'warning' | 'error'
const LEVEL_DB = { debug: 'DEBUG', info: 'INFO', warning: 'WARNING', error: 'ERROR' } as const;

export interface ActivityInput {
  action: string;
  level?: Level;
  actorId?: string | null;
  actorEmail?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  detail?: string | null;
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
      },
    });
  } catch (e) {
    logger.error('Failed to persist activity log', { action: input.action, error: String(e) });
  }
}
