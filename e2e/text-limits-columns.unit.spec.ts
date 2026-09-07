import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { TEXT_LIMITS } from '@/lib/textLimits';

// The invariant `src/lib/textLimits.ts` states in its own header, checked
// against the schema instead of trusted (#1433).
//
//   server cap > column width → Prisma P2000 ("Data too long"), which no route
//   handles, so it surfaces as a 500.
//
// Two fields had drifted past it. `Company.name` had no `max()` at all on
// either side, so a 250-character paste reached MySQL and came back to the
// admin as "Internal server error"; `ProjectTask.title` was capped at 300
// against a VARCHAR(191) column, and the to-dos endpoint had no try/catch, so
// the same paste produced a 500 with an EMPTY BODY and the UI said nothing.
//
// The three assertions below are deliberately separate, because each one alone
// is satisfiable by a wrong fix:
//
//   1. the constant equals what the column can actually hold (parsed from
//      prisma/schema.prisma — the source of truth, not a number retyped here);
//   2. the guarded fields reference the constant rather than an inline number,
//      which is the rule the limits file exists to enforce;
//   3. a schema built from the constant accepts the column's capacity exactly
//      and rejects one character more.
//
// Raising `TEXT_LIMITS.todoTitle` back to 300 fails (1) and (3); re-inlining a
// literal in a route fails (2).

const root = process.cwd();
const schemaSource = fs.readFileSync(path.join(root, 'prisma/schema.prisma'), 'utf8');

/**
 * The width of one `String` column, read from the schema. A `String` with no
 * `@db.` attribute is VARCHAR(191) in MySQL — that default is exactly what made
 * both bugs invisible in review, so it is spelled out here.
 */
function columnWidth(model: string, field: string): number {
  const block = new RegExp(`^model ${model} \\{$([\\s\\S]*?)^\\}$`, 'm').exec(schemaSource);
  expect(block, `model ${model} not found in prisma/schema.prisma`).not.toBeNull();
  const line = new RegExp(`^\\s+${field}\\s+String\\??\\s*(.*)$`, 'm').exec(block![1]);
  expect(line, `${model}.${field} not found (or not a String)`).not.toBeNull();
  const attrs = line![1];
  const explicit = /@db\.VarChar\((\d+)\)/.exec(attrs);
  expect(attrs, `${model}.${field} is a TEXT column — this spec is about VARCHAR bounds`).not.toMatch(
    /@db\.(Text|MediumText|LongText)/,
  );
  return explicit ? Number(explicit[1]) : 191;
}

const FIELDS = [
  { limit: 'companyName', model: 'Company', column: 'name' },
  { limit: 'companyAddress', model: 'Company', column: 'address' },
  { limit: 'todoTitle', model: 'ProjectTask', column: 'title' },
] as const;

for (const { limit, model, column } of FIELDS) {
  test(`TEXT_LIMITS.${limit} fits ${model}.${column}`, async () => {
    expect(TEXT_LIMITS[limit]).toBeLessThanOrEqual(columnWidth(model, column));
  });

  test(`${model}.${column} accepts the column's capacity and rejects one more`, async () => {
    const width = columnWidth(model, column);
    const schema = z.string().min(1).max(TEXT_LIMITS[limit]);

    // At the limit: fine. One over: rejected here, not by the database driver.
    expect(schema.safeParse('x'.repeat(width)).success).toBe(true);
    expect(schema.safeParse('x'.repeat(width + 1)).success).toBe(false);

    // And the 250-character paste from the bug report, which used to 500.
    expect(schema.safeParse('x'.repeat(250)).success).toBe(false);
  });
}

// Every place that guards one of these fields, and the constant it must use.
// A route that goes back to an inline number silently reopens the drift the
// limits file was written to close.
const GUARDS: { file: string; limit: keyof typeof TEXT_LIMITS }[] = [
  { file: 'src/app/api/companies/route.ts', limit: 'companyName' },
  { file: 'src/app/api/companies/route.ts', limit: 'companyAddress' },
  { file: 'src/app/api/companies/[id]/route.ts', limit: 'companyName' },
  { file: 'src/app/api/companies/[id]/route.ts', limit: 'companyAddress' },
  { file: 'src/components/forms/CompanyForm.tsx', limit: 'companyName' },
  { file: 'src/components/forms/CompanyForm.tsx', limit: 'companyAddress' },
  { file: 'src/app/api/todos/route.ts', limit: 'todoTitle' },
  { file: 'src/app/api/projects/[id]/tasks/route.ts', limit: 'todoTitle' },
  { file: 'src/app/api/project-tasks/[taskId]/route.ts', limit: 'todoTitle' },
  { file: 'src/components/todos/MyTodos.tsx', limit: 'todoTitle' },
  { file: 'src/components/todos/PersonTodos.tsx', limit: 'todoTitle' },
  { file: 'src/components/todos/TodoRow.tsx', limit: 'todoTitle' },
];

for (const { file, limit } of GUARDS) {
  test(`${file} caps with TEXT_LIMITS.${limit}, not a literal`, async () => {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    expect(source).toContain(`TEXT_LIMITS.${limit}`);
  });
}

test('POST /api/todos can no longer answer with an empty-bodied 500', async () => {
  const source = fs.readFileSync(path.join(root, 'src/app/api/todos/route.ts'), 'utf8');
  const post = source.slice(source.indexOf('export async function POST'));
  // A catch that returns JSON is what turns "the box just sits there" into a
  // message the client can read out.
  expect(post).toMatch(/catch \(error\)[\s\S]*NextResponse\.json\([\s\S]*status: 500/);
});
