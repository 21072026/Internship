// The tenant hard-delete EXECUTOR (#1584, docs/tenant-lifecycle.md § Hard delete).
//
// Takes the Prisma client as an argument and imports no app singleton, so the
// e2e suite can run the real deletion against its own synthetic tenant while
// the server's switch stays off (e2e/tenant-hard-delete.spec.ts). Every gate —
// the switch, archive, the two stages, the password — is the caller's
// (src/lib/orgDeletion.ts); this file only deletes, and only what
// planDeletion() names.
//
// ONE TRANSACTION, THREE PHASES:
//   1. read  — walk the plan parent-first and collect, for every step, the ids
//              of the rows it will delete and the keys its children hang off;
//   2. null  — every optional link into the deleted set is set to NULL (a row
//              of another org that only points here keeps living; a row about
//              to go stops constraining the order);
//   3. delete — children first, in the plan's topological order, then the org.
// Any failure rolls the whole thing back; nothing is half-deleted.

import { Prisma, type PrismaClient } from '@prisma/client';
import { planDeletion, type DeletionPlan, type SchemaModel } from './orgDeletionRule';

const IN_CHUNK = 1000;
const HAS_ID = new Set(
  Prisma.dmmf.datamodel.models.filter((m) => m.fields.some((f) => f.name === 'id' && f.isId)).map((m) => m.name),
);

/** Models the plan reaches by a link (not by orgId) must be deletable by id. */
export function viaStepsWithoutId(plan: DeletionPlan): string[] {
  return plan.deletes.filter((s) => s.where !== 'org' && !HAS_ID.has(s.model)).map((s) => s.model);
}
export const DELETE_TX_TIMEOUT_MS = 10 * 60_000;

export function schemaModels(): SchemaModel[] {
  return Prisma.dmmf.datamodel.models.map((m) => ({
    name: m.name,
    hasOrgId: m.fields.some((f) => f.name === 'orgId' && f.kind === 'scalar'),
    links: m.fields
      .filter((f) => f.kind === 'object' && (f.relationFromFields?.length ?? 0) > 0)
      .map((f) => ({
        model: f.type,
        fields: f.relationFromFields ?? [],
        references: f.relationToFields ?? [],
        required: (f.relationFromFields ?? []).every((fn) => m.fields.find((x) => x.name === fn)?.isRequired === true),
      })),
  }));
}

export function deletionPlan(): DeletionPlan {
  return planDeletion(schemaModels());
}

type Tx = Prisma.TransactionClient;
type Delegate = {
  findMany: (args: unknown) => Promise<Record<string, unknown>[]>;
  updateMany: (args: unknown) => Promise<{ count: number }>;
  deleteMany: (args: unknown) => Promise<{ count: number }>;
};

function delegate(tx: Tx, model: string): Delegate {
  const d = (tx as unknown as Record<string, Delegate | undefined>)[model.charAt(0).toLowerCase() + model.slice(1)];
  if (!d) throw new Error(`No Prisma delegate for ${model}`);
  return d;
}

function chunks<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += IN_CHUNK) out.push(xs.slice(i, i + IN_CHUNK));
  return out;
}

/** Rows deleted per model, plus the links nulled. */
export interface DeletionResult {
  deleted: Record<string, number>;
  nulled: number;
}

export async function deleteTenantRows(client: PrismaClient, orgId: string, plan: DeletionPlan = deletionPlan()): Promise<DeletionResult> {
  if (plan.unhandled.length) throw new Error(`Deletion plan has unhandled links: ${plan.unhandled.join('; ')}`);

  // Which key columns of which model anything downstream needs.
  const wanted = new Map<string, Set<string>>();
  const want = (model: string, col: string) => {
    if (!wanted.has(model)) wanted.set(model, new Set());
    wanted.get(model)!.add(col);
  };
  for (const s of plan.deletes) if (s.where !== 'org') for (const v of s.where) want(v.parent, v.parentKey);
  for (const n of plan.nullify) want(n.parent, n.parentKey);

  // Parent-first read order: org-scoped steps, then the rest in plan order
  // reversed (children-first reversed is parents-first for required links),
  // and keep passing until no step learns a new row — optional links are not
  // ordered by the plan.
  const readOrder = [
    ...plan.deletes.filter((s) => s.where === 'org'),
    ...[...plan.deletes].reverse().filter((s) => s.where !== 'org'),
  ];

  return client.$transaction(
    async (tx) => {
      const keys = new Map<string, Map<string, Set<unknown>>>();
      const keySet = (model: string, col: string) => {
        if (!keys.has(model)) keys.set(model, new Map());
        const m = keys.get(model)!;
        if (!m.has(col)) m.set(col, new Set());
        return m.get(col)!;
      };
      keySet('Organization', 'id').add(orgId);
      const ids = new Map<string, Set<unknown>>();

      const readStep = async (step: (typeof plan.deletes)[number]): Promise<boolean> => {
        // A model without an `id` column (a small join/state table) is
        // org-scoped by construction and deleted by its WHERE, not by id.
        const cols = new Set<string>([...(HAS_ID.has(step.model) ? ['id'] : []), ...(wanted.get(step.model) ?? [])]);
        if (!cols.size) return false;
        const select = Object.fromEntries([...cols].map((c) => [c, true]));
        const d = delegate(tx, step.model);
        const wheres: Record<string, unknown>[] = [];
        if (step.where === 'org') wheres.push({ orgId });
        else
          for (const v of step.where) {
            const vals = [...(keys.get(v.parent)?.get(v.parentKey) ?? [])];
            for (const c of chunks(vals)) wheres.push({ [v.field]: { in: c } });
          }
        let learned = false;
        const seen = ids.get(step.model) ?? new Set<unknown>();
        ids.set(step.model, seen);
        for (const where of wheres) {
          const rows = await d.findMany({ where, select });
          for (const r of rows) {
            if (r.id !== undefined && !seen.has(r.id)) {
              seen.add(r.id);
              learned = true;
            }
            for (const c of wanted.get(step.model) ?? []) if (r[c] != null) keySet(step.model, c).add(r[c]);
          }
        }
        return learned;
      };

      for (let pass = 0, learned = true; learned && pass < 10; pass++) {
        learned = false;
        for (const step of readOrder) if (await readStep(step)) learned = true;
      }

      let nulled = 0;
      for (const n of plan.nullify) {
        const vals = [...(keys.get(n.parent)?.get(n.parentKey) ?? [])];
        for (const c of chunks(vals)) {
          nulled += (await delegate(tx, n.model).updateMany({ where: { [n.field]: { in: c } }, data: { [n.field]: null } })).count;
        }
      }

      const deleted: Record<string, number> = {};
      for (const step of plan.deletes) {
        const d = delegate(tx, step.model);
        let count = 0;
        if (step.where === 'org') {
          count = (await d.deleteMany({ where: { orgId } })).count;
        } else {
          for (const c of chunks([...(ids.get(step.model) ?? [])])) count += (await d.deleteMany({ where: { id: { in: c } } })).count;
        }
        if (count) deleted[step.model] = count;
      }
      await tx.organization.delete({ where: { id: orgId } });
      deleted.Organization = 1;
      return { deleted, nulled };
    },
    { timeout: DELETE_TX_TIMEOUT_MS, maxWait: 30_000 },
  );
}
