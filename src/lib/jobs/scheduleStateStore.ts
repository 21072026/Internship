import { prisma } from '@/lib/prisma';
import type { ScheduleStateStore } from './scheduler';

// The Prisma half of the scheduler's state (#1676). `advance()` is ONE
// conditional statement — the same shape as every lease transition: an
// `updateMany` whose WHERE carries the value the caller read, or an insert that
// loses quietly to a concurrent one (primary key).
export function prismaScheduleStateStore(): ScheduleStateStore {
  return {
    read: async (keys) => {
      const rows = await prisma.scheduleState.findMany({ where: { name: { in: [...keys] } } });
      return new Map(rows.map((r) => [r.name, r.lastEnqueuedSlot]));
    },
    advance: async (key, from, to) => {
      if (from === undefined) {
        try {
          await prisma.scheduleState.create({ data: { name: key, lastEnqueuedSlot: to } });
          return true;
        } catch {
          // P2002: another ticker inserted first. Its slot stands.
          return false;
        }
      }
      const { count } = await prisma.scheduleState.updateMany({
        where: { name: key, lastEnqueuedSlot: from },
        data: { lastEnqueuedSlot: to },
      });
      return count === 1;
    },
  };
}
