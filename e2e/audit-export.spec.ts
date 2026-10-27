import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';
// Static import, not `await import()`: Playwright resolves the alias when it
// transforms the spec's import graph (see retention-prune.spec.ts).
import { pruneAuditLog } from '../src/lib/retentionEntries';

// The audit trail's two finishing moves (#1585), against a real database.
//
//  1. The CSV export is behind `audit.export` (an OBSERVER may read the trail
//     but not carry it away), covers EVERY matching row rather than the visible
//     page of 50, stays inside the caller's org, and neutralises formula cells.
//  2. The retention sweep takes only out-of-window rows, and never a row a
//     tenant's audit drain (#2012) has not shipped yet.

const PASSWORD = 'AuditExport123!';
const DAY = 24 * 60 * 60 * 1000;

test.afterAll(async () => {
  await prisma.$disconnect();
});

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

test(
  'audit.export: an admin downloads every filtered row of its own org; an observer and a mentor are refused',
  { tag: '@smoke' },
  async ({ playwright }) => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const org = await prisma.organization.create({ data: { name: `AuditExp Org ${stamp}`, slug: `auditexp-${stamp}` } });
    const other = await prisma.organization.create({ data: { name: `AuditExp Other ${stamp}`, slug: `auditexp-o-${stamp}` } });
    const emails: string[] = [];
    const mk = async (tag: string, role: 'ADMIN' | 'MENTOR', orgId = org.id) => {
      const email = uniqueEmail(`auditexp-${tag}`);
      emails.push(email);
      const u = await seedUser(email, PASSWORD, role, `AuditExp ${tag}`, orgId);
      return { id: u.id, email };
    };
    const admin = await mk('admin', 'ADMIN');
    const observer = await mk('observer', 'ADMIN');
    const mentor = await mk('mentor', 'MENTOR');
    const foreignAdmin = await mk('foreign', 'ADMIN', other.id);
    await prisma.user.update({ where: { id: observer.id }, data: { adminLevel: 'OBSERVER' } });

    // 120 matching rows — more than two viewer pages — plus one that the filter
    // excludes and one of another org under the same action prefix.
    const prefix = `E2E_EXP_${stamp.replace(/-/g, '_')}`;
    const base = Date.now() - 60_000;
    await prisma.auditLog.createMany({
      data: [
        ...Array.from({ length: 120 }, (_, i) => ({
          actorId: admin.id,
          action: `${prefix}_HIT`,
          detail: i === 0 ? '=HYPERLINK("http://evil.example")' : `row ${i}`,
          orgId: org.id,
          createdAt: new Date(base + i),
        })),
        { actorId: admin.id, action: `OTHER_${stamp}`, orgId: org.id },
        { actorId: foreignAdmin.id, action: `${prefix}_HIT`, orgId: other.id },
      ],
    });

    const ctxs: APIRequestContext[] = [];
    const as = async (email: string) => {
      const ctx = await playwright.request.newContext();
      ctxs.push(ctx);
      expect((await signInViaApi(ctx, email, PASSWORD)).ok).toBeTruthy();
      return ctx;
    };
    try {
      const adminCtx = await as(admin.email);
      const url = `/api/admin/audit/export?action=${encodeURIComponent(prefix)}`;
      const res = await adminCtx.get(url);
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toContain('text/csv');
      expect(res.headers()['content-disposition']).toContain('attachment');
      expect(res.headers()['x-export-truncated']).toBeUndefined();

      // The viewer's total for the same filter is the file's row count.
      const view = await (await adminCtx.get(`/api/admin/audit?action=${encodeURIComponent(prefix)}`)).json();
      expect(view.total).toBe(120);
      expect(view.items.length).toBe(50);

      const rows = parseCsv(await res.text());
      expect(rows[0]).toEqual(['createdAt', 'action', 'actorEmail', 'actorId', 'targetId', 'detail']);
      const body = rows.slice(1);
      expect(body.length).toBe(view.total);
      expect(res.headers()['x-export-total']).toBe('120');
      expect(new Set(body.map((r) => r[1]))).toEqual(new Set([`${prefix}_HIT`]));
      expect(new Set(body.map((r) => r[2]))).toEqual(new Set([admin.email]));
      // Newest first, and the formula cell is neutralised.
      expect(body[body.length - 1][5]).toBe(`'=HYPERLINK("http://evil.example")`);

      // The export is itself on the record.
      const logged = await prisma.activityLog.findFirst({ where: { action: 'audit.exported', actorId: admin.id } });
      expect(logged?.detail).toContain('rows=120');

      // OBSERVER holds audit.read, not audit.export.
      const observerCtx = await as(observer.email);
      expect((await observerCtx.get(`/api/admin/audit?action=${encodeURIComponent(prefix)}`)).status()).toBe(200);
      expect((await observerCtx.get(url)).status()).toBe(403);
      expect((await (await as(mentor.email)).get(url)).status()).toBe(403);
      const anon = await playwright.request.newContext();
      ctxs.push(anon);
      expect((await anon.get(url)).status()).toBe(401);

      // No route deletes a single audit row.
      expect((await adminCtx.delete('/api/admin/audit')).status()).toBe(405);
    } finally {
      for (const c of ctxs) await c.dispose();
      const ids = (await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } })).map((u) => u.id);
      await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
      await prisma.activityLog.deleteMany({ where: { actorId: { in: ids } } });
      await prisma.activityLog.deleteMany({ where: { actorEmail: { in: emails } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
      await prisma.organization.deleteMany({ where: { id: { in: [org.id, other.id] } } });
    }
  },
);

test(
  'the audit sweep takes only out-of-window rows, and never a row a drain still owes its receiver',
  { tag: '@smoke' },
  async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const plain = await prisma.organization.create({ data: { name: `AuditRet Plain ${stamp}`, slug: `auditret-p-${stamp}` } });
    const streamed = await prisma.organization.create({ data: { name: `AuditRet Stream ${stamp}`, slug: `auditret-s-${stamp}` } });
    const owed = await prisma.organization.create({ data: { name: `AuditRet Owed ${stamp}`, slug: `auditret-o-${stamp}` } });
    const actorId = `e2e-auditret-${stamp}`;
    const now = new Date();
    const ancient = (d: number) => new Date(now.getTime() - d * DAY);

    const mk = (orgId: string, tag: string, createdAt: Date) =>
      prisma.auditLog.create({ data: { actorId, action: `E2E_RET_${tag}`, orgId, createdAt } });
    try {
      const plainOld = await mk(plain.id, 'PLAIN_OLD', ancient(800));
      const plainNew = await mk(plain.id, 'PLAIN_NEW', ancient(10));
      // Inside the floor even though the configured window says 30 days.
      const plainFloor = await mk(plain.id, 'PLAIN_FLOOR', ancient(200));
      const shipped = await mk(streamed.id, 'SHIPPED', ancient(900));
      const unshipped = await mk(streamed.id, 'UNSHIPPED', ancient(850));
      const owedOld = await mk(owed.id, 'OWED', ancient(900));

      await prisma.auditDrain.createMany({
        data: [
          // Shipped up to and including `shipped`.
          { orgId: streamed.id, url: 'https://siem.acme.example/a', secret: 's', cursorAt: shipped.createdAt, cursorId: shipped.id },
          // Paused and never shipped anything: holds the whole org.
          { orgId: owed.id, url: 'https://siem.acme.example/b', secret: 's', active: false },
        ],
      });

      // Configured at 30 days: the sweep raises it to the one-year floor.
      const out = await pruneAuditLog({ now, cutoff: ancient(30), retentionDays: 30, batchSize: 500, budget: 50_000 });
      expect(out.deleted).toBeGreaterThanOrEqual(2);

      const left = new Set(
        (await prisma.auditLog.findMany({ where: { actorId }, select: { id: true } })).map((r) => r.id),
      );
      expect(left.has(plainOld.id)).toBe(false);
      expect(left.has(shipped.id)).toBe(false);
      expect(left.has(plainNew.id)).toBe(true);
      expect(left.has(plainFloor.id)).toBe(true);
      expect(left.has(unshipped.id)).toBe(true);
      expect(left.has(owedOld.id)).toBe(true);
    } finally {
      await prisma.auditLog.deleteMany({ where: { actorId } });
      await prisma.auditDrain.deleteMany({ where: { orgId: { in: [streamed.id, owed.id] } } });
      await prisma.organization.deleteMany({ where: { id: { in: [plain.id, streamed.id, owed.id] } } });
    }
  },
);
