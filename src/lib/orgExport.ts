// The tenant offboarding export (#1584, docs/tenant-lifecycle.md § Export).
// Server-only. What may be in it is src/lib/orgExportPolicy.ts; this file
// walks the schema and writes the JSON.
//
// THE WALK. Driven by Prisma's own schema model (DMMF), not by a hand-written
// list, so a model added tomorrow is exported tomorrow: every model carrying
// `orgId` (`where: { orgId }`), then every model reached through a foreign key
// from rows already exported (`where: { <fk>: { in: <their keys> } }`), level
// by level — InteractionLog through its relation, Message through its relation,
// MessageAttachment through its message, and so on (planWalk()).
//
// STREAMED, NOT BUILT. The document is produced as an async iterable of text
// chunks, rows read in id-ordered pages, so a large tenant never sits in memory
// as one object. Only the key sets the next level needs are kept.
//
// SHAPE.
//   { "_meta": { format, exportedAt, organization, omittedModels, omittedFields,
//                encoding },
//     "organization": { …the org row, credentials omitted… },
//     "collections": { "<Model>": [ …rows… ], … },
//     "_summary": { "<Model>": <row count>, … } }
// Bytes columns are base64 strings; BigInt and Decimal are strings; dates are
// ISO-8601. Notification rows carry an extra `renderedText` (#921 stores params,
// not text), rendered in the exporting operator's language.

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { runWithOrg } from '@/lib/orgContext';
import {
  OMITTED_FIELDS,
  OMITTED_MODELS,
  isFieldOmitted,
  planWalk,
  type WalkModel,
} from '@/lib/orgExportPolicy';
import { renderNotification, type NotificationDict } from '@/lib/notificationText';
import type { Locale } from '@/i18n/config';

export const ORG_EXPORT_FORMAT = 'interncrm.tenant-export/1';

const PAGE = 500;
const BLOB_PAGE = 20;
const IN_CHUNK = 1000;

type DmmfModel = (typeof Prisma.dmmf.datamodel.models)[number];

function walkModels(): WalkModel[] {
  return Prisma.dmmf.datamodel.models.map((m) => ({
    name: m.name,
    hasOrgId: m.fields.some((f) => f.name === 'orgId' && f.kind === 'scalar'),
    parents: m.fields
      .filter((f) => f.kind === 'object' && (f.relationFromFields?.length ?? 0) > 0)
      .map((f) => ({ model: f.type, fields: f.relationFromFields ?? [], references: f.relationToFields ?? [] })),
  }));
}

function delegate(model: string) {
  const key = model.charAt(0).toLowerCase() + model.slice(1);
  return (prisma as unknown as Record<string, { findMany: (args: unknown) => Promise<Record<string, unknown>[]> }>)[key];
}

function idField(m: DmmfModel): string | null {
  const id = m.fields.find((f) => f.isId);
  return id && m.fields.filter((f) => f.isId).length === 1 ? id.name : null;
}

/** Plain JSON values: Bytes → base64, BigInt/Decimal → string, Date → ISO. */
function plain(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (Prisma.Decimal.isDecimal(value)) return (value as Prisma.Decimal).toString();
  return value;
}

function rowOut(model: string, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (isFieldOmitted(model, k)) continue;
    out[k] = plain(v);
  }
  return out;
}

export interface OrgExportOptions {
  orgId: string;
  /** For rendering notification text. */
  dict: NotificationDict;
  locale: Locale;
  /** Called once, after the last chunk, with the row counts. */
  onDone?: (summary: Record<string, number>) => Promise<void> | void;
}

/**
 * The export as text chunks. Every database read runs inside
 * `runWithOrg(orgId)`, so the tenant middleware — when it enforces — agrees
 * with the explicit `where: { orgId }` instead of fighting it.
 */
export async function* orgExportChunks(opts: OrgExportOptions): AsyncGenerator<string> {
  const { orgId } = opts;
  const dmmf = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]));
  const plan = planWalk(walkModels());

  // Which key columns of which model the next levels will ask for.
  const wanted = new Map<string, Set<string>>();
  for (const step of plan) {
    for (const v of step.via) {
      if (!wanted.has(v.parent)) wanted.set(v.parent, new Set());
      wanted.get(v.parent)!.add(v.parentKey);
    }
  }
  const keys = new Map<string, Map<string, Set<unknown>>>();
  const remember = (model: string, row: Record<string, unknown>) => {
    const cols = wanted.get(model);
    if (!cols) return;
    if (!keys.has(model)) keys.set(model, new Map());
    const byCol = keys.get(model)!;
    for (const c of cols) {
      const v = row[c];
      if (v === null || v === undefined) continue;
      if (!byCol.has(c)) byCol.set(c, new Set());
      byCol.get(c)!.add(v);
    }
  };

  const org = await runWithOrg(orgId, () => prisma.organization.findUnique({ where: { id: orgId } }));
  if (!org) throw new Error('Organization not found');
  if (wanted.has('Organization')) remember('Organization', org as unknown as Record<string, unknown>);

  const meta = {
    format: ORG_EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    organization: { id: org.id, slug: org.slug, name: org.name },
    encoding: { bytes: 'base64', bigint: 'string', decimal: 'string', dates: 'ISO-8601' },
    omittedModels: OMITTED_MODELS,
    omittedFields: OMITTED_FIELDS,
  };
  yield `{\n"_meta": ${JSON.stringify(meta)},\n"organization": ${JSON.stringify(rowOut('Organization', org as unknown as Record<string, unknown>))},\n"collections": {`;

  const summary: Record<string, number> = {};
  let firstModel = true;
  for (const step of plan) {
    const m = dmmf.get(step.model);
    const d = delegate(step.model);
    if (!m || !d) continue;
    const id = idField(m);
    const hasBlob = m.fields.some((f) => f.type === 'Bytes');
    const page = hasBlob ? BLOB_PAGE : PAGE;

    // The WHERE: own orgId, or "any parent key I hang off was exported".
    const ors: Record<string, unknown>[][] = [];
    if (step.via.length === 0) {
      ors.push([{ orgId }]);
    } else {
      const clauses: Record<string, unknown>[] = [];
      for (const v of step.via) {
        const vals = [...(keys.get(v.parent)?.get(v.parentKey) ?? [])];
        for (let i = 0; i < vals.length; i += IN_CHUNK) clauses.push({ [v.field]: { in: vals.slice(i, i + IN_CHUNK) } });
      }
      if (!clauses.length) {
        summary[step.model] = 0;
        continue;
      }
      // One query per clause batch keeps each IN list bounded; a row reached
      // through two parents is de-duplicated by its id below.
      for (const c of clauses) ors.push([c]);
    }

    yield `${firstModel ? '' : ','}\n${JSON.stringify(step.model)}: [`;
    firstModel = false;
    let count = 0;
    const seen = id && step.via.length > 1 ? new Set<unknown>() : null;
    for (const [where] of ors) {
      let cursor: unknown = undefined;
      for (;;) {
        // A model without a single-column id cannot be paged by cursor; those
        // are small join/state tables and are read whole.
        const args: Record<string, unknown> = { where };
        if (id) {
          args.take = page;
          args.orderBy = { [id]: 'asc' };
          if (cursor !== undefined) {
            args.cursor = { [id]: cursor };
            args.skip = 1;
          }
        }
        const rows = await runWithOrg(orgId, () => d.findMany(args));
        for (const row of rows) {
          if (seen) {
            if (seen.has(row[id!])) continue;
            seen.add(row[id!]);
          }
          remember(step.model, row);
          const out = rowOut(step.model, row);
          if (step.model === 'Notification') {
            try {
              out.renderedText = renderNotification(row as unknown as Parameters<typeof renderNotification>[0], opts.dict, opts.locale);
            } catch {
              out.renderedText = null;
            }
          }
          yield `${count === 0 ? '' : ','}\n${JSON.stringify(out)}`;
          count++;
        }
        if (!id || rows.length < page) break;
        cursor = rows[rows.length - 1][id];
      }
    }
    summary[step.model] = count;
    yield '\n]';
  }

  yield `\n},\n"_summary": ${JSON.stringify(summary)}\n}\n`;
  await opts.onDone?.(summary);
}
