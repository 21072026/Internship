import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { logActivity } from '@/lib/activity';
import { resolveOrgId } from '@/lib/orgScope';
import { withTenantScope } from '@/lib/orgContext';
import { enforceRateLimit } from '@/lib/rateLimit';
import { planLimits, isOrgPlan } from '@/lib/orgPlans';
import { findPossibleDuplicates } from '@/lib/duplicateDetection';
import { createInvitation, discardInvitation } from '@/lib/inviteCreate';
import {
  BULK_INVITE_MAX_CHARS,
  BULK_INVITE_ROLES,
  mapWithConcurrency,
  parseBulkInvite,
  summarizeBulkInvite,
  validateBulkInvite,
  type BulkInviteReportRow,
} from '@/lib/bulkInvite';

// POST /api/admin/invite/bulk — one paste, one preview, one send (#2070).
//
// Two modes over ONE validator (src/lib/bulkInvite.ts): `dryRun: true` returns
// the verdict, `dryRun` absent creates exactly the rows that verdict called
// invitable. Both answer 200 with the full per-row report — a 500 in the middle
// of 300 addresses tells the admin nothing about what did or did not happen.
//
// Creation goes through createInvitation(), the same path the single-address
// form uses, so orgId (#678), the auto-pairing pointers and the mail template
// cannot drift between the two entry points.

const schema = z.object({
  rows: z.string().min(1).max(BULK_INVITE_MAX_CHARS),
  defaultRole: z.enum(BULK_INVITE_ROLES),
  dryRun: z.boolean().optional(),
});

// How many invitations may be in flight to the relay at once. Small on
// purpose: throughput is not the point, surviving a 5 000-row paste is.
const SEND_CONCURRENCY = 4;

// Duplicate pre-flight is a full mentee scan per row, so it is only worth
// running for a roster a human is about to read. Beyond this the report keeps
// its shape and simply carries no `possibleDuplicates`.
const DUPLICATE_SCAN_MAX_ROWS = 100;

// Chunked so a 5 000-address paste never builds one enormous IN (...) list.
const LOOKUP_CHUNK = 500;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Seats left under the tenant's plan; null = unlimited (or no org resolved). */
async function seatsAvailable(orgId: string | null): Promise<number | null> {
  if (!orgId) return null;
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { plan: true } });
  const plan = org && isOrgPlan(org.plan) ? org.plan : null;
  if (!plan) return null;
  const limit = planLimits(plan).maxUsers;
  if (limit == null) return null;
  const usage = await prisma.user.count({ where: { orgId } });
  return Math.max(0, limit - usage);
}

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    // Checked in the handler, not in middleware: inviting a whole roster is an
    // admin act, and a MENTOR (who may invite a single mentee) gets a 403 here.
    if (session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Per user, not just per IP: several admins behind one office NAT should
    // not spend each other's budget, and one admin cannot loop the send.
    const limited = enforceRateLimit(request, `invite-bulk:${session.user.id}`, {
      limit: 10,
      windowMs: 10 * 60 * 1000,
    });
    if (limited) return limited;

    return await withTenantScope(session, async () => {
      const parsedBody = schema.safeParse(await request.json());
      if (!parsedBody.success) {
        return NextResponse.json(
          { error: 'Validation failed', details: parsedBody.error.flatten() },
          { status: 400 },
        );
      }
      const { defaultRole } = parsedBody.data;
      const dryRun = parsedBody.data.dryRun === true;
      const orgId = resolveOrgId(session);

      const parsed = parseBulkInvite(parsedBody.data.rows);
      const candidates = [...new Set(parsed.rows.map((r) => r.email.trim().toLowerCase()).filter(Boolean))];

      const existingUserEmails = new Set<string>();
      const pendingInviteEmails = new Set<string>();
      const now = new Date();
      for (const part of chunk(candidates, LOOKUP_CHUNK)) {
        const users = await prisma.user.findMany({ where: { email: { in: part } }, select: { email: true } });
        for (const u of users) existingUserEmails.add(u.email.toLowerCase());
        const tokens = await prisma.invitationToken.findMany({
          where: { email: { in: part }, used: false, expiresAt: { gt: now } },
          select: { email: true },
        });
        for (const t of tokens) if (t.email) pendingInviteEmails.add(t.email.toLowerCase());
      }

      const report = validateBulkInvite(parsed, {
        defaultRole,
        existingUserEmails,
        pendingInviteEmails,
        seatsAvailable: await seatsAvailable(orgId),
      });

      // Warn-only look-alike check (#841), same as the CSV importer.
      const named = parsed.rows.filter((r) => r.fullName);
      if (named.length <= DUPLICATE_SCAN_MAX_ROWS) {
        const byRow = new Map(report.map((r) => [r.row, r]));
        for (const raw of named) {
          const entry = byRow.get(raw.row);
          if (!entry || entry.status !== 'invite' || !raw.fullName) continue;
          const matches = await findPossibleDuplicates({ orgId, fullName: raw.fullName });
          if (matches.length > 0) {
            entry.possibleDuplicates = matches.map((m) => ({ id: m.id, fullName: m.fullName, matchedOn: m.signals }));
          }
        }
      }

      const summary = summarizeBulkInvite(report);
      if (dryRun) {
        return NextResponse.json({ dryRun: true, truncated: parsed.truncated, created: 0, ...summary, rows: report });
      }

      // Real run — create exactly the rows the verdict called invitable.
      const byRowNumber = new Map(parsed.rows.map((r) => [r.row, r]));
      const toSend = report.filter((r) => r.status === 'invite');
      let created = 0;
      await mapWithConcurrency(toSend, SEND_CONCURRENCY, async (entry: BulkInviteReportRow) => {
        const raw = byRowNumber.get(entry.row);
        try {
          const result = await createInvitation({
            actor: { id: session.user.id, email: session.user.email },
            orgId,
            email: entry.email,
            label: raw?.label ?? null,
            role: entry.role,
            request,
          });
          if (result.mailError) {
            // Not half-created: the token goes away with the failed send, so
            // the address can be retried by pasting it again.
            await discardInvitation(result.invitationId);
            entry.status = 'error';
            entry.reason = 'send_failed';
            return;
          }
          // "The transport did not throw" is NOT "the mail was delivered"
          // (#1431): sendEmail() answers SKIPPED without throwing in demo mode
          // and on any env with no SMTP_USER. Carry the transport's own verdict
          // into the row so a created-but-unmailed invitation cannot be
          // reported as one that was sent.
          entry.emailSent = result.emailSent;
          // Its link, only when it was not mailed: GET /api/invite withholds
          // the token of every invitation that has an email address, so this
          // response is the admin's one chance to keep a link they now have to
          // deliver by hand.
          if (!result.emailSent) entry.registerUrl = result.registerUrl;
          created++;
        } catch (err) {
          console.error('Bulk invite row failed:', err);
          entry.status = 'error';
          entry.reason = 'send_failed';
        }
      });

      const outcome = summarizeBulkInvite(report);

      await logActivity({
        action: 'invite.bulk_created',
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        detail: `created ${created}/${summary.invitable} · emailed ${outcome.emailed} · ${defaultRole}`,
        request,
      });

      return NextResponse.json({
        dryRun: false,
        truncated: parsed.truncated,
        created,
        ...outcome,
        rows: report,
      });
    });
  } catch (error) {
    console.error('Bulk invite error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
