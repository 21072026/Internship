import type { Prisma } from '@prisma/client';

// The AuditLog rules of #1585 — the retention window, what the sweep may take,
// and the CSV export's shape. Pure (a type import only), so the unit spec
// (e2e/audit-retention.unit.spec.ts) pins every rule without a database.
//
// THE ONE DELETER. The age-based sweep registered in retentionEntries.ts is the
// only code path that removes an audit row. There is no route, button or admin
// action that deletes a single row, and there must never be one: a trail an
// admin can selectively erase is not an audit trail.

/** Twenty-four months: two full annual audit cycles, which is what a security questionnaire asks about. */
export const AUDIT_RETENTION_DEFAULT_DAYS = 730;

/**
 * No window shorter than a year, whatever the setting says. The impersonation
 * and password-reset rows here are evidence, and evidence is asked about
 * months after the fact — the ActivityLog's security window is a year too.
 */
export const AUDIT_RETENTION_FLOOR_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The effective window: the configured one, raised to the floor. */
export function auditRetentionDays(configured: number): number {
  if (!Number.isFinite(configured) || configured <= 0) return AUDIT_RETENTION_DEFAULT_DAYS;
  return Math.max(AUDIT_RETENTION_FLOOR_DAYS, Math.floor(configured));
}

export function auditRetentionCutoff(now: Date, configuredDays: number): Date {
  return new Date(now.getTime() - auditRetentionDays(configuredDays) * DAY_MS);
}

/** One registered audit drain's position (AuditDrain, #2012). */
export interface DrainCursor {
  orgId: string;
  cursorAt: Date | null;
  cursorId: string | null;
}

/**
 * Per org, the position EVERY drain of that org has shipped past — the oldest
 * cursor among them. `null` means at least one drain has shipped nothing yet,
 * so the org's whole trail is still owed to it.
 *
 * Paused drains count too (`active: false`): the drain pauses itself after
 * repeated failures (auditDrainRule.afterAttempt), and that is exactly the
 * outage in which a sweep would otherwise open a silent gap in the tenant's
 * SIEM. Deleting the drain is what releases its rows.
 */
export function shippedFloorByOrg(drains: DrainCursor[]): Map<string, { at: Date; id: string } | null> {
  const floor = new Map<string, { at: Date; id: string } | null>();
  for (const d of drains) {
    const pos = d.cursorAt && d.cursorId ? { at: d.cursorAt, id: d.cursorId } : null;
    if (!floor.has(d.orgId)) {
      floor.set(d.orgId, pos);
      continue;
    }
    const cur = floor.get(d.orgId)!;
    if (cur === null) continue;
    if (pos === null) {
      floor.set(d.orgId, null);
      continue;
    }
    const older = pos.at.getTime() < cur.at.getTime() || (pos.at.getTime() === cur.at.getTime() && pos.id < cur.id);
    if (older) floor.set(d.orgId, pos);
  }
  return floor;
}

/**
 * The rows the sweep may delete: older than the cutoff AND, in an org with a
 * drain, at or before the position every drain has shipped. The cursor
 * comparison is the drain's own `nextRowsWhere` turned around (`lte` where it
 * reads `gt`), so the two always split the trail at the same row.
 *
 * NULL-org rows are never shipped by any drain (auditDrain.ts), so only the
 * window applies to them.
 */
export function auditPrunableWhere(cutoff: Date, drains: DrainCursor[]): Prisma.AuditLogWhereInput {
  const floor = shippedFloorByOrg(drains);
  if (floor.size === 0) return { createdAt: { lt: cutoff } };
  const drainOrgs = [...floor.keys()];
  const shipped: Prisma.AuditLogWhereInput[] = [];
  for (const [orgId, pos] of floor) {
    if (pos === null) continue; // nothing shipped: nothing of this org may go
    shipped.push({
      orgId,
      OR: [{ createdAt: { lt: pos.at } }, { createdAt: pos.at, id: { lte: pos.id } }],
    });
  }
  return {
    createdAt: { lt: cutoff },
    OR: [{ orgId: null }, { orgId: { notIn: drainOrgs } }, ...shipped],
  };
}

// ── The CSV export ──────────────────────────────────────────────────────────

/** The columns, in order — the issue's contract with whoever reads the file. */
export const AUDIT_EXPORT_COLUMNS = ['createdAt', 'action', 'actorEmail', 'actorId', 'targetId', 'detail'] as const;

/**
 * The most rows one export carries. A larger result is cut at the newest
 * AUDIT_EXPORT_MAX_ROWS and the response says so (X-Export-Truncated), so a
 * reviewer narrows the date range instead of trusting a partial file.
 */
export const AUDIT_EXPORT_MAX_ROWS = 10_000;

/**
 * A spreadsheet cell that cannot become a formula (CSV injection): `detail`
 * and `action` carry free text an admin typed (an impersonation reason), and
 * Excel executes a cell starting with = + - @ or a tab/CR. Quoted, inner
 * quotes doubled (RFC 4180).
 */
export function auditCsvCell(value: unknown): string {
  let text = value instanceof Date ? value.toISOString() : String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export interface AuditExportRow {
  createdAt: Date;
  action: string;
  actorEmail: string | null;
  actorId: string;
  targetId: string | null;
  detail: string | null;
}

/** Header line (with a BOM, so Excel reads UTF-8) — the first chunk of the file. */
export function auditCsvHeader(): string {
  return '﻿' + AUDIT_EXPORT_COLUMNS.map(auditCsvCell).join(',') + '\r\n';
}

export function auditCsvLine(r: AuditExportRow): string {
  return AUDIT_EXPORT_COLUMNS.map((c) => auditCsvCell(r[c])).join(',') + '\r\n';
}
