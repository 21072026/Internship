// The mentor-limits import (#1808, part 2) — the Prisma-aware half. Mapping and
// validation are pure in mentorLimitsImport.ts; this file supplies `resolve`
// (one batched read of the mentors, their limits and booking policies) and
// `apply` (one transaction per chunk) to the ONE engine, `runImport()`. A
// preview is the same call with a writer that does not write (#1432).
//
// Never creates an account: an address that is not a mentor of the admin's org
// is reported (`not_found` / `not_a_mentor`) and left alone. The booking columns
// go onto MentorBookingPolicy (#2003), upserted by `mentorId` — the same upsert
// as PUT /api/availability/policy, touching only the columns the row names.
// Idempotent: a re-run of the same file reads UNCHANGED everywhere.

import { prisma } from '@/lib/prisma';
import { orgWhere, withinTenant } from '@/lib/tenantFilter';
import { parseDelimited, runImport, type ImportReport, type PlannedRow, type RowResult } from '@/lib/importPreview';
import {
  MENTOR_LIMITS_IMPORT_MAX_ROWS,
  POLICY_LIMIT_FIELDS,
  USER_LIMIT_FIELDS,
  belowWeeklyCap,
  changedLimits,
  mapLimitColumns,
  validateLimitsRow,
  type LimitsRowValue,
} from '@/lib/mentorLimitsImport';

export class MentorLimitsImportError extends Error {
  constructor(public code: string, public column?: string) {
    super(code);
  }
}

interface Planned {
  userId: string;
  values: LimitsRowValue;
}

/** Only the columns the row named — an empty cell never reaches a write. */
function pick<K extends keyof LimitsRowValue>(values: LimitsRowValue, keys: readonly K[]): Pick<LimitsRowValue, K> {
  return Object.fromEntries(keys.filter((k) => k in values).map((k) => [k, values[k]])) as Pick<LimitsRowValue, K>;
}

export async function runMentorLimitsImport(options: { orgId: string; text: string; apply: boolean; delimiter?: string }): Promise<ImportReport<Planned>> {
  const table = parseDelimited(options.text, { delimiter: options.delimiter });
  if (table.rows.length > MENTOR_LIMITS_IMPORT_MAX_ROWS) throw new MentorLimitsImportError('too_many_rows');
  const mapped = mapLimitColumns(table.header);
  if (!mapped.ok) throw new MentorLimitsImportError(mapped.code, mapped.column);
  const map = mapped.map;
  const tenant = await orgWhere(options.orgId);

  return runImport<LimitsRowValue, Planned>({
    parse: () => table,
    validate: (row) => validateLimitsRow(row, map),
    async resolve(rows) {
      const emails = [...new Set(rows.map((r) => r.key))];
      // The org's own people only — another tenant's address is "not found".
      const users = emails.length
        ? await prisma.user.findMany({
            where: withinTenant({ email: { in: emails } }, tenant),
            select: {
              id: true,
              email: true,
              role: true,
              mentorCapacity: true,
              selfMatchLimit: true,
              acceptingMentees: true,
              bookingPolicy: { select: { minNoticeMinutes: true, maxPerMonth: true, maxPerWeek: true } },
            },
          })
        : [];
      const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), u]));
      const seen = new Set<string>();
      const plan: PlannedRow<Planned>[] = rows.map((r) => {
        const user = byEmail.get(r.key);
        const skip = (reason: string, userId = ''): PlannedRow<Planned> => ({ row: r.row, key: r.key, status: 'SKIP', reason, value: { userId, values: r.value } });
        if (!user) return skip('not_found');
        if (user.role !== 'MENTOR' && user.role !== 'ADMIN') return skip('not_a_mentor', user.id);
        if (seen.has(user.id)) return skip('duplicate_row', user.id);
        seen.add(user.id);
        const current = { mentorCapacity: user.mentorCapacity, selfMatchLimit: user.selfMatchLimit, acceptingMentees: user.acceptingMentees, policy: user.bookingPolicy };
        if (belowWeeklyCap(r.value, current)) return skip('below_weekly', user.id);
        const changed = changedLimits(r.value, current);
        const value = { userId: user.id, values: r.value };
        if (changed.length === 0) return { row: r.row, key: r.key, status: 'UNCHANGED', value, targetId: user.id };
        return { row: r.row, key: r.key, status: 'UPDATE', changed, value, targetId: user.id };
      });
      return { plan, absent: [] };
    },
    async apply(chunk, { dryRun }) {
      const results: RowResult<Planned>[] = chunk.map((p) => ({ ...p }));
      if (dryRun) return results;
      const writes = chunk
        .filter((p) => p.status === 'UPDATE')
        .flatMap((p) => {
          const { userId, values } = p.value;
          const userData = pick(values, USER_LIMIT_FIELDS);
          const policyData = pick(values, POLICY_LIMIT_FIELDS);
          return [
            ...(Object.keys(userData).length ? [prisma.user.update({ where: { id: userId }, data: userData })] : []),
            ...(Object.keys(policyData).length
              ? [prisma.mentorBookingPolicy.upsert({ where: { mentorId: userId }, create: { mentorId: userId, ...policyData }, update: policyData })]
              : []),
          ];
        });
      if (writes.length) await prisma.$transaction(writes);
      return results;
    },
    dryRun: !options.apply,
  });
}
