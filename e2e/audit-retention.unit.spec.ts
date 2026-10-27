import { test, expect } from '@playwright/test';
import {
  AUDIT_EXPORT_COLUMNS,
  AUDIT_RETENTION_DEFAULT_DAYS,
  AUDIT_RETENTION_FLOOR_DAYS,
  auditCsvCell,
  auditCsvHeader,
  auditCsvLine,
  auditPrunableWhere,
  auditRetentionDays,
  shippedFloorByOrg,
} from '@/lib/auditRetentionRule';

// The AuditLog rules of #1585, without a database: the window and its floor,
// what the sweep may take when a tenant streams its trail (#2012), and the CSV
// cell that cannot become a formula. The database-backed half is
// e2e/audit-export.spec.ts.

test('the window: 24 months by default, never under a year, junk falls back', { tag: '@smoke' }, () => {
  expect(AUDIT_RETENTION_DEFAULT_DAYS).toBe(730);
  expect(auditRetentionDays(730)).toBe(730);
  expect(auditRetentionDays(30)).toBe(AUDIT_RETENTION_FLOOR_DAYS);
  expect(auditRetentionDays(0)).toBe(AUDIT_RETENTION_DEFAULT_DAYS);
  expect(auditRetentionDays(-5)).toBe(AUDIT_RETENTION_DEFAULT_DAYS);
  expect(auditRetentionDays(Number.NaN)).toBe(AUDIT_RETENTION_DEFAULT_DAYS);
  expect(auditRetentionDays(1000.7)).toBe(1000);
});

test('a drain that shipped nothing holds its whole org; the oldest cursor wins', { tag: '@smoke' }, () => {
  const t1 = new Date('2025-01-01T00:00:00Z');
  const t2 = new Date('2025-06-01T00:00:00Z');
  const floor = shippedFloorByOrg([
    { orgId: 'a', cursorAt: t2, cursorId: 'z' },
    { orgId: 'a', cursorAt: t1, cursorId: 'm' },
    { orgId: 'b', cursorAt: t2, cursorId: 'x' },
    { orgId: 'b', cursorAt: null, cursorId: null },
    { orgId: 'c', cursorAt: t1, cursorId: 'b' },
    { orgId: 'c', cursorAt: t1, cursorId: 'a' },
  ]);
  expect(floor.get('a')).toEqual({ at: t1, id: 'm' });
  expect(floor.get('b')).toBeNull();
  expect(floor.get('c')).toEqual({ at: t1, id: 'a' });
});

test('the prunable filter: window always, drain cursor where a drain exists', { tag: '@smoke' }, () => {
  const cutoff = new Date('2026-01-01T00:00:00Z');
  expect(auditPrunableWhere(cutoff, [])).toEqual({ createdAt: { lt: cutoff } });

  const at = new Date('2025-03-01T00:00:00Z');
  const where = auditPrunableWhere(cutoff, [
    { orgId: 'shipped', cursorAt: at, cursorId: 'row9' },
    { orgId: 'owed', cursorAt: null, cursorId: null },
  ]);
  expect(where).toEqual({
    createdAt: { lt: cutoff },
    OR: [
      { orgId: null },
      { orgId: { notIn: ['shipped', 'owed'] } },
      { orgId: 'shipped', OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lte: 'row9' } }] },
    ],
  });
  // 'owed' appears nowhere as an allowed branch: none of its rows may go.
  expect(JSON.stringify(where.OR)).not.toContain('"orgId":"owed"');
});

test('CSV: fixed columns, BOM, quoting, and no cell can become a formula', { tag: '@smoke' }, () => {
  expect(AUDIT_EXPORT_COLUMNS).toEqual(['createdAt', 'action', 'actorEmail', 'actorId', 'targetId', 'detail']);
  expect(auditCsvHeader()).toBe('﻿"createdAt","action","actorEmail","actorId","targetId","detail"\r\n');
  for (const evil of ['=HYPERLINK("http://x.example")', '+1', '-1+2', '@SUM(A1)', '\tx', '\rx']) {
    expect(auditCsvCell(evil).startsWith(`"'`)).toBe(true);
  }
  expect(auditCsvCell('say "hi"')).toBe('"say ""hi"""');
  expect(auditCsvCell(null)).toBe('""');
  expect(
    auditCsvLine({
      createdAt: new Date('2026-10-27T10:00:00.000Z'),
      action: 'IMPERSONATE_START',
      actorEmail: 'a@acme.example',
      actorId: 'u1',
      targetId: null,
      detail: '=cmd',
    }),
  ).toBe('"2026-10-27T10:00:00.000Z","IMPERSONATE_START","a@acme.example","u1","","\'=cmd"\r\n');
});
