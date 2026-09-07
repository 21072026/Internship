import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { TEXT_LIMITS, type TextLimitKey } from '@/lib/textLimits';

// The invariant `src/lib/textLimits.ts` states in its own header, checked
// against the schema instead of trusted (#1433).
//
//   server cap > column width → Prisma P2000 ("Data too long"), which no route
//   handles, so it surfaces as a 500.
//
// `Company.name` had no `max()` at all on either side, so a 250-character paste
// reached MySQL and came back to the admin as "Internal server error";
// `ProjectTask.title` (and `ProjectTaskTemplate.title`, whose wording is copied
// into it verbatim) was capped at 300 against a VARCHAR(191) column, and the
// to-dos endpoint had no try/catch, so the same paste produced a 500 with an
// EMPTY BODY and the UI said nothing.
//
// THE POINT OF THIS FILE is that the list below is not hand-picked. Every
// `String` column of the guarded models is read out of prisma/schema.prisma and
// must appear in `COLUMN_GUARDS` — either with the constant that bounds it, or
// with a written reason why it needs none. Adding a sixth text field to the
// company modal without capping it fails here, which is exactly how the first
// version of this fix missed `industry` and `logoUrl` sitting one input to the
// right of the field it corrected.
//
// The assertions are deliberately separate, because each one alone is
// satisfiable by a wrong fix:
//
//   1. every String column is accounted for (capped, or exempt with a reason);
//   2. the constant fits what the column can actually hold (parsed from
//      prisma/schema.prisma — the source of truth, not a number retyped here);
//   3. the guarding files reference the constant rather than an inline number,
//      which is the rule the limits file exists to enforce;
//   4. a schema built from the constant accepts the column's capacity exactly
//      and rejects one character more.
//
// Raising `TEXT_LIMITS.todoTitle` back to 300 fails (2) and (4); re-inlining a
// literal in a route fails (3); a new uncapped column fails (1).

const root = process.cwd();
const schemaSource = fs.readFileSync(path.join(root, 'prisma/schema.prisma'), 'utf8');

type Column = { name: string; kind: 'varchar'; width: number } | { name: string; kind: 'text' };

/**
 * Every `String` column of one model, with its width. A `String` with no `@db.`
 * attribute is VARCHAR(191) in MySQL — that default is exactly what made both
 * bugs invisible in review, so it is spelled out here.
 */
function stringColumns(model: string): Column[] {
  const block = new RegExp(`^model ${model} \\{$([\\s\\S]*?)^\\}$`, 'm').exec(schemaSource);
  expect(block, `model ${model} not found in prisma/schema.prisma`).not.toBeNull();
  const columns: Column[] = [];
  for (const line of block![1].split('\n')) {
    // `name String?  @db.VarChar(500)` — a relation field (`company Company`) or
    // a non-String scalar never matches.
    const match = /^\s+(\w+)\s+String\??\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, name, attrs] = match;
    if (/@db\.(Text|MediumText|LongText)/.test(attrs)) {
      columns.push({ name, kind: 'text' });
      continue;
    }
    const explicit = /@db\.VarChar\((\d+)\)/.exec(attrs);
    columns.push({ name, kind: 'varchar', width: explicit ? Number(explicit[1]) : 191 });
  }
  expect(columns.length, `no String columns found in model ${model}`).toBeGreaterThan(0);
  return columns;
}

type Guard =
  /** The constant that bounds this column, and every file that must use it. */
  | { limit: TextLimitKey; files: string[] }
  /** Not free text a user types — say why, so the next reader can disagree. */
  | { exempt: string };

/** A cuid the server generates, or a foreign key that has to match a real row. */
const ID = { exempt: 'an id — server-generated, or matched against an existing row' } as const;

const COMPANY_WRITERS = [
  'src/app/api/companies/route.ts',
  'src/app/api/companies/[id]/route.ts',
  'src/components/forms/CompanyForm.tsx',
];
const TASK_WRITERS = [
  'src/app/api/todos/route.ts',
  'src/app/api/projects/[id]/tasks/route.ts',
  'src/app/api/project-tasks/[taskId]/route.ts',
  'src/components/todos/MyTodos.tsx',
  'src/components/todos/PersonTodos.tsx',
  'src/components/todos/TodoRow.tsx',
];
const TEMPLATE_WRITERS = [
  'src/lib/goalTemplates.ts',
  'src/app/api/admin/goal-templates/route.ts',
  'src/app/api/projects/[id]/task-templates/route.ts',
];

// The models the "Add company" modal and the to-do surface write into. Every
// String column of each one is accounted for below — the test fails on a column
// that is missing from this map, not merely on one that is wrong.
const COLUMN_GUARDS: Record<string, Record<string, Guard>> = {
  Company: {
    id: ID,
    orgId: ID,
    name: { limit: 'companyName', files: COMPANY_WRITERS },
    description: { limit: 'companyDescription', files: COMPANY_WRITERS },
    contactEmail: { limit: 'companyContactEmail', files: COMPANY_WRITERS },
    industry: { limit: 'companyIndustry', files: COMPANY_WRITERS },
    logoUrl: { limit: 'companyLogoUrl', files: COMPANY_WRITERS },
    size: { limit: 'companySize', files: COMPANY_WRITERS },
    address: { limit: 'companyAddress', files: COMPANY_WRITERS },
  },
  CompanyNeed: {
    id: ID,
    companyId: ID,
    position: { limit: 'companyNeedPosition', files: COMPANY_WRITERS },
    period: { limit: 'companyNeedPeriod', files: COMPANY_WRITERS },
  },
  ProjectTask: {
    id: ID,
    projectId: ID,
    assigneeId: ID,
    createdById: ID,
    templateId: ID,
    title: { limit: 'todoTitle', files: TASK_WRITERS },
  },
  ProjectTaskTemplate: {
    id: ID,
    projectId: ID,
    createdById: ID,
    // The same constant as ProjectTask.title, and not by coincidence: a
    // template's wording is written into a task's title unchanged.
    title: { limit: 'todoTitle', files: TEMPLATE_WRITERS },
  },
};

for (const [model, guards] of Object.entries(COLUMN_GUARDS)) {
  const columns = stringColumns(model);

  test(`every String column of ${model} is capped or exempt`, async () => {
    const unaccounted = columns.map((c) => c.name).filter((name) => !(name in guards));
    expect(
      unaccounted,
      `add ${model}.${unaccounted.join('/')} to COLUMN_GUARDS: either the TEXT_LIMITS key that ` +
        'bounds it in every schema that writes it, or an exemption with a reason',
    ).toEqual([]);

    // And nothing stale: a guard for a column the schema no longer has would
    // quietly stop testing anything.
    const gone = Object.keys(guards).filter((name) => !columns.some((c) => c.name === name));
    expect(gone, `${model} no longer has these columns — drop them from COLUMN_GUARDS`).toEqual([]);
  });

  for (const column of columns) {
    const guard = guards[column.name];
    if (!guard || 'exempt' in guard) continue;
    const { limit } = guard;

    test(`TEXT_LIMITS.${limit} fits ${model}.${column.name}`, async () => {
      if (column.kind === 'text') {
        // @db.Text is 65 535 BYTES; utf8mb4 Turkish/German runs 2-3 bytes per
        // non-ASCII character, so the limits file caps TEXT-backed fields at
        // 20 000 characters.
        expect(TEXT_LIMITS[limit]).toBeLessThanOrEqual(20000);
        return;
      }
      expect(TEXT_LIMITS[limit]).toBeLessThanOrEqual(column.width);
    });

    if (column.kind === 'varchar') {
      test(`${model}.${column.name} rejects one character past the column`, async () => {
        const schema = z.string().min(1).max(TEXT_LIMITS[limit]);

        // At the constant: fine. Past the column: rejected here, not by the
        // database driver.
        expect(schema.safeParse('x'.repeat(TEXT_LIMITS[limit])).success).toBe(true);
        expect(schema.safeParse('x'.repeat(column.width + 1)).success).toBe(false);

        // And the 250-character paste from the bug report, which used to 500.
        expect(schema.safeParse('x'.repeat(250)).success).toBe(false);
      });
    }
  }
}

// Every place that guards one of these columns, and the constant it must use.
// A route that goes back to an inline number silently reopens the drift the
// limits file was written to close.
const GUARDED_FILES = new Map<string, Set<TextLimitKey>>();
for (const guards of Object.values(COLUMN_GUARDS)) {
  for (const guard of Object.values(guards)) {
    if ('exempt' in guard) continue;
    for (const file of guard.files) {
      if (!GUARDED_FILES.has(file)) GUARDED_FILES.set(file, new Set());
      GUARDED_FILES.get(file)!.add(guard.limit);
    }
  }
}

for (const [file, limits] of GUARDED_FILES) {
  for (const limit of limits) {
    test(`${file} caps with TEXT_LIMITS.${limit}, not a literal`, async () => {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      expect(source).toContain(`TEXT_LIMITS.${limit}`);
    });
  }
}

test('POST /api/todos can no longer answer with an empty-bodied 500', async () => {
  const source = fs.readFileSync(path.join(root, 'src/app/api/todos/route.ts'), 'utf8');
  const post = source.slice(source.indexOf('export async function POST'));
  // A catch that returns JSON is what turns "the box just sits there" into a
  // message the client can read out.
  expect(post).toMatch(/catch \(error\)[\s\S]*NextResponse\.json\([\s\S]*status: 500/);
  // …and it has to cover the session read, not just the work after it. The jwt
  // callback queries the DB on every request (the `sessionsValidFrom` revocation
  // check), so a pool timeout rejects there — outside a `try` that starts later,
  // which is a catch that guards nothing that can realistically throw.
  // Comments are stripped first: the handler's own comment explains this, and
  // matching that prose instead of the call would make the test always pass.
  const code = post.replace(/^\s*\/\/.*$/gm, '');
  const body = code.slice(code.indexOf('{'));
  expect(body.indexOf('try {'), 'move `try {` above the getServerSession call').toBeLessThan(
    body.indexOf('getServerSession('),
  );
});

test('a template title cannot outgrow the task title it becomes', async () => {
  // `canonicalTitle`/`normalizeTranslations` slice to their own constant before
  // the value is written; if that constant drifts past the column again, the
  // route's zod cap is bypassed by the slice rather than enforced by it.
  const source = fs.readFileSync(path.join(root, 'src/lib/goalTemplates.ts'), 'utf8');
  expect(source).toMatch(/const MAX_TITLE = TEXT_LIMITS\.todoTitle;/);
});
