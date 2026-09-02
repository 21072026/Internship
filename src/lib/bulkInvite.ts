// Bulk invitations (#2070) — parsing and the ONE validator.
//
// Onboarding a 300-person programme used to mean 300 trips through the
// single-address form. This module turns one paste into a per-row verdict.
//
// THE INVARIANT: the dry run and the real run share this validator, so the
// dry run's `invitable` count is exactly what the real run creates for the
// same input. The CSV importer's dry run computes its verdict a second time
// (#1432) and drifts from the run it is supposed to predict — a preview you
// cannot trust is worse than no preview. Nothing here touches the database:
// the route gathers the facts (existing users, live invitations, seats) and
// hands them in, which is also what makes the invariant testable.
//
// Pure + dependency-free (except the shared text limits) on purpose.
import { TEXT_LIMITS } from '@/lib/textLimits';

/** One paste, hard-capped. Beyond this the report says so instead of stalling. */
export const BULK_INVITE_MAX_ROWS = 5000;
/** Paste size cap, generous enough for 5 000 CSV rows. */
export const BULK_INVITE_MAX_CHARS = 500_000;

/**
 * ADMIN is deliberately absent: an admin seat is a one-at-a-time decision,
 * never something that arrives inside a pasted spreadsheet column.
 */
export const BULK_INVITE_ROLES = ['MENTOR', 'MENTEE'] as const;
export type BulkInviteRole = (typeof BULK_INVITE_ROLES)[number];

/**
 * Reserved domains that must never receive mail: the public demo's synthetic
 * accounts and the RFC-style placeholder people paste from examples. Sending
 * to either is at best noise and at worst the demo acting as an open relay.
 */
export const BULK_INVITE_UNMAILABLE_DOMAINS = ['demo.example.com', 'sample.invalid'] as const;

export type BulkInviteStatus = 'invite' | 'skip' | 'error';

export type BulkInviteReason =
  | 'invalid_email'
  | 'email_too_long'
  | 'name_too_long'
  | 'label_too_long'
  | 'admin_not_allowed'
  | 'invalid_role'
  | 'unmailable_domain'
  | 'duplicate_in_paste'
  | 'already_user'
  | 'already_invited'
  | 'seat_limit'
  | 'too_many_rows'
  | 'send_failed';

export interface BulkInviteParsedRow {
  /** 1-based, counted after the optional header row. */
  row: number;
  email: string;
  fullName: string | null;
  /** Raw per-row role cell, unvalidated. */
  role: string | null;
  label: string | null;
}

export interface BulkInviteDuplicate {
  id: string;
  fullName: string;
  matchedOn: string[];
}

/** Mirrors the CSV importer's per-row report shape (`create` → `invite`). */
export interface BulkInviteReportRow {
  row: number;
  email: string;
  role: BulkInviteRole;
  status: BulkInviteStatus;
  reason?: BulkInviteReason;
  /** Look-alike existing mentees (#841) — warn-only, the row is still invitable. */
  possibleDuplicates?: BulkInviteDuplicate[];
}

export interface BulkInviteContext {
  defaultRole: BulkInviteRole;
  /** Lowercased addresses that already have an account. */
  existingUserEmails: ReadonlySet<string>;
  /** Lowercased addresses with an unused, unexpired invitation. */
  pendingInviteEmails: ReadonlySet<string>;
  /** Seats left under the tenant's plan; null = unlimited. */
  seatsAvailable: number | null;
}

// Same shape the CSV importer accepts — deliberately liberal, the mail
// transport is the real judge of deliverability.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Split one CSV line honouring simple double-quoted fields.
 * Copied in behaviour from src/app/api/admin/import/route.ts:16 — same doubled
 * quote handling, same trim.
 */
export function parseBulkInviteLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export interface ParsedBulkInvite {
  rows: BulkInviteParsedRow[];
  /** True when the paste held more than BULK_INVITE_MAX_ROWS usable lines. */
  truncated: boolean;
}

/**
 * Parse a paste of `email[,fullName,role,label]` lines (a bare address list is
 * the one-column case). Handles a UTF-8 BOM, CRLF, blank lines and an optional
 * header row whose first cell is literally "email".
 */
export function parseBulkInvite(text: string): ParsedBulkInvite {
  const withoutBom = text.replace(/^﻿/, '');
  const lines = withoutBom
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // Header detection: only an exact "email" first cell. No real address is
  // literally "email", so this can never eat a row.
  if (lines.length > 0 && parseBulkInviteLine(lines[0])[0]?.toLowerCase() === 'email') {
    lines.shift();
  }

  const truncated = lines.length > BULK_INVITE_MAX_ROWS;
  const usable = truncated ? lines.slice(0, BULK_INVITE_MAX_ROWS) : lines;

  return {
    truncated,
    rows: usable.map((line, i) => {
      const [email, fullName, role, label] = parseBulkInviteLine(line);
      return {
        row: i + 1,
        email: email ?? '',
        fullName: fullName || null,
        role: role || null,
        label: label || null,
      };
    }),
  };
}

function resolveRole(raw: string | null, fallback: BulkInviteRole): { role: BulkInviteRole; reason?: BulkInviteReason } {
  if (!raw) return { role: fallback };
  const upper = raw.trim().toUpperCase();
  if (upper === 'ADMIN') return { role: fallback, reason: 'admin_not_allowed' };
  if ((BULK_INVITE_ROLES as readonly string[]).includes(upper)) return { role: upper as BulkInviteRole };
  return { role: fallback, reason: 'invalid_role' };
}

/**
 * The single verdict function. Called once by the dry run and once by the real
 * run — never re-derived. Row order matters: "first one wins" for a duplicate
 * inside the paste, and seats are consumed top-down.
 */
export function validateBulkInvite(
  parsed: ParsedBulkInvite,
  ctx: BulkInviteContext,
): BulkInviteReportRow[] {
  const seen = new Set<string>();
  let invitable = 0;
  const report: BulkInviteReportRow[] = [];

  for (const raw of parsed.rows) {
    const { role, reason: roleReason } = resolveRole(raw.role, ctx.defaultRole);
    const email = raw.email.trim();
    const key = email.toLowerCase();
    const push = (status: BulkInviteStatus, reason?: BulkInviteReason) =>
      report.push({ row: raw.row, email, role, status, ...(reason ? { reason } : {}) });

    if (roleReason) {
      push('error', roleReason);
      continue;
    }
    if (!email || !EMAIL_RE.test(email)) {
      push('error', 'invalid_email');
      continue;
    }
    if (email.length > TEXT_LIMITS.invitationEmail) {
      // Left to the column this would be a Prisma P2000 surfacing as a 500 (#1432).
      push('error', 'email_too_long');
      continue;
    }
    if (raw.fullName && raw.fullName.length > TEXT_LIMITS.invitationFullName) {
      push('error', 'name_too_long');
      continue;
    }
    if (raw.label && raw.label.length > TEXT_LIMITS.invitationLabel) {
      push('error', 'label_too_long');
      continue;
    }
    if (BULK_INVITE_UNMAILABLE_DOMAINS.some((d) => key.endsWith(`@${d}`))) {
      push('skip', 'unmailable_domain');
      continue;
    }
    if (seen.has(key)) {
      push('skip', 'duplicate_in_paste');
      continue;
    }
    seen.add(key);
    if (ctx.existingUserEmails.has(key)) {
      push('skip', 'already_user');
      continue;
    }
    if (ctx.pendingInviteEmails.has(key)) {
      push('skip', 'already_invited');
      continue;
    }
    if (ctx.seatsAvailable != null && invitable >= ctx.seatsAvailable) {
      push('skip', 'seat_limit');
      continue;
    }
    invitable++;
    push('invite');
  }

  return report;
}

export interface BulkInviteSummary {
  total: number;
  invitable: number;
  skipped: number;
  errors: number;
}

export function summarizeBulkInvite(rows: readonly BulkInviteReportRow[]): BulkInviteSummary {
  return {
    total: rows.length,
    invitable: rows.filter((r) => r.status === 'invite').length,
    skipped: rows.filter((r) => r.status === 'skip').length,
    errors: rows.filter((r) => r.status === 'error').length,
  };
}

/**
 * Run `worker` over `items` with at most `limit` in flight.
 *
 * NOT `Promise.all` over 300 addresses: that hands the SMTP relay 300
 * simultaneous connections, which is how one paste takes the mail transport
 * (and every other email the app sends) down with it.
 */
export async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const width = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < items.length) {
        const index = next++;
        await worker(items[index]);
      }
    }),
  );
}
