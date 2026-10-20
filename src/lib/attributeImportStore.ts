// The attribute-value import (#1920, part 2) — the Prisma-aware half. The
// column mapping and row validation are pure in attributeImport.ts; this file
// supplies `resolve` (one batched read of the people and their current values)
// and `apply` (one transaction per chunk) to the ONE engine, `runImport()` in
// src/lib/importPreview.ts. A preview is the same call with a writer that does
// not write — never a second code path (#1432).
//
// Idempotent by construction: every write is an upsert on
// @@unique([userId, attributeId]), so a re-run of the same file writes nothing
// new and two concurrent applies cannot duplicate a row — no lease is needed.

import { prisma } from '@/lib/prisma';
import { orgWhere, withinTenant } from '@/lib/tenantFilter';
import { parseDelimited, runImport, type ImportReport, type PlannedRow, type RowResult } from '@/lib/importPreview';
import {
  ATTRIBUTE_IMPORT_MAX_ROWS,
  changedAttributes,
  mapColumns,
  validateAttributeRow,
  type AttributeRowValue,
  type ColumnMap,
} from '@/lib/attributeImport';

export class AttributeImportError extends Error {
  constructor(public code: string, public column?: string) {
    super(code);
  }
}

interface Planned {
  userId: string;
  values: AttributeRowValue;
}

export async function runAttributeImport(options: { orgId: string; text: string; apply: boolean; delimiter?: string }): Promise<ImportReport<Planned>> {
  const { orgId } = options;
  const attributes = await prisma.orgAttribute.findMany({
    where: { orgId },
    select: { id: true, key: true, labelEn: true, labelTr: true, labelDe: true, type: true, options: true },
  });
  const table = parseDelimited(options.text, { delimiter: options.delimiter });
  if (table.rows.length > ATTRIBUTE_IMPORT_MAX_ROWS) throw new AttributeImportError('too_many_rows');
  const mapped = mapColumns(table.header, attributes);
  if (!mapped.ok) throw new AttributeImportError(mapped.code, mapped.column);
  const map: ColumnMap = mapped.map;
  const keyOf = new Map(attributes.map((a) => [a.id, a.key]));
  const tenant = await orgWhere(orgId);

  return runImport<AttributeRowValue, Planned>({
    parse: () => table,
    validate: (row) => validateAttributeRow(row, map),
    async resolve(rows) {
      const emails = [...new Set(rows.map((r) => r.key))];
      // The org's own people only — an address of another tenant is "not found".
      const users = emails.length
        ? await prisma.user.findMany({ where: withinTenant({ email: { in: emails } }, tenant), select: { id: true, email: true } })
        : [];
      const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), u.id]));
      const current = users.length
        ? await prisma.userAttributeValue.findMany({
            where: { orgId, userId: { in: users.map((u) => u.id) } },
            select: { userId: true, attributeId: true, value: true },
          })
        : [];
      const valuesOf = new Map<string, Map<string, string>>();
      for (const v of current) {
        if (!valuesOf.has(v.userId)) valuesOf.set(v.userId, new Map());
        valuesOf.get(v.userId)!.set(v.attributeId, v.value);
      }
      const seen = new Set<string>();
      const plan: PlannedRow<Planned>[] = rows.map((r) => {
        const userId = byEmail.get(r.key);
        if (!userId) return { row: r.row, key: r.key, status: 'SKIP', reason: 'not_found', value: { userId: '', values: r.value } };
        if (seen.has(userId)) return { row: r.row, key: r.key, status: 'SKIP', reason: 'duplicate_row', value: { userId, values: r.value } };
        seen.add(userId);
        const have = valuesOf.get(userId) ?? new Map<string, string>();
        const changed = changedAttributes(r.value, have);
        if (changed.length === 0) return { row: r.row, key: r.key, status: 'UNCHANGED', value: { userId, values: r.value }, targetId: userId };
        const status = changed.some((id) => have.has(id)) ? 'UPDATE' : 'CREATE';
        return { row: r.row, key: r.key, status, changed: changed.map((id) => keyOf.get(id) ?? id), value: { userId, values: r.value }, targetId: userId };
      });
      return { plan, absent: [] };
    },
    async apply(chunk, { dryRun }) {
      const results: RowResult<Planned>[] = chunk.map((p) => ({ ...p }));
      if (dryRun) return results;
      const writes = chunk
        .filter((p) => p.status === 'CREATE' || p.status === 'UPDATE')
        .flatMap((p) =>
          Object.entries(p.value.values).map(([attributeId, value]) =>
            prisma.userAttributeValue.upsert({
              where: { userId_attributeId: { userId: p.value.userId, attributeId } },
              create: { orgId, userId: p.value.userId, attributeId, value },
              update: { value },
            })
          )
        );
      if (writes.length) await prisma.$transaction(writes);
      return results;
    },
    dryRun: !options.apply,
  });
}
