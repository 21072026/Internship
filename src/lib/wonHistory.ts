// The database half of "did this record ever sign?" (rule: `recordsEverWon()` in
// src/lib/accountEventRule.ts). One grouped read for any number of records, so
// the account-event ingest (one record) and the prospect retention list (every
// account of an org) ask the same question the same way.

import { prisma } from '@/lib/prisma';
import type { Db } from '@/lib/dbHandle';
import { WON_STAGE_KEY, recordsEverWon, wonHistoryWhere } from '@/lib/accountEventRule';

/** The ids among `records` that are at DEAL_WON or ever moved into it. */
export async function relationsEverWon(
  records: readonly { id: string; pipelineStatus: string | null }[],
  db: Db = prisma,
): Promise<Set<string>> {
  // Records already at the won stage need no history read.
  const unknown = records.filter((r) => r.pipelineStatus !== WON_STAGE_KEY).map((r) => r.id);
  const history =
    unknown.length === 0
      ? []
      : await db.statusChange.findMany({
          where: wonHistoryWhere(unknown),
          select: { relationId: true },
          distinct: ['relationId'],
        });
  return recordsEverWon(records, history.map((h) => h.relationId));
}
