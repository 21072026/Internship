import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { sendInvitationEmail } from '@/services/emailService';
import { withTenantScope } from '@/lib/orgContext';
import { orgScoped, resolveOrgId } from '@/lib/orgScope';
import { enforceRateLimit, rateLimit } from '@/lib/rateLimit';
import {
  deriveInvitationStatus,
  isInvitationDeletable,
  isInvitationResendable,
  isInvitationRevocable,
  isSyntheticInviteEmail,
} from '@/lib/invitationStatus';

// Bulk actions behind the invitation status board (#2071).
//
// Same three explicit guards as the board's GET, for the same reasons: ADMIN
// checked in this handler (a MENTOR gets 403 even though they may resend their
// OWN invitations one at a time via /api/invite/[id]), the tenant filter written
// by hand because InvitationToken is not in TENANT_MODELS, and the per-row
// eligibility taken from src/lib/invitationStatus.ts rather than re-derived.
//
// Every row reports its own outcome. A bulk action over 50 rows where 3 were
// skipped must say which 3 — "50 selected, 47 resent" with no detail is how an
// admin ends up re-inviting the same person twice.

const bodySchema = z.object({
  // Same ceiling as the candidates bulk route.
  ids: z.array(z.string().min(1)).min(1).max(200),
  action: z.enum(['resend', 'revoke', 'delete']),
});

// Bulk resend fans out mail. Four at a time keeps the SMTP connection pool and
// the request itself bounded; the batch cap above bounds the total.
const SEND_CONCURRENCY = 4;

type Outcome =
  | 'resent'
  | 'refreshed'
  | 'revoked'
  | 'deleted'
  | 'skippedRegistered'
  | 'skippedRevoked'
  | 'skippedOpened'
  | 'notFound';

interface RowResult {
  id: string;
  ok: boolean;
  outcome: Outcome;
  email: string | null;
  label: string | null;
}

/** Run `task` over `items` with a small fixed concurrency, in order. */
async function pooled<T, R>(items: T[], task: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += SEND_CONCURRENCY) {
    out.push(...(await Promise.all(items.slice(i, i + SEND_CONCURRENCY).map(task))));
  }
  return out;
}

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const limited = enforceRateLimit(request, 'invitations-bulk', { limit: 20, windowMs: 60_000 });
    if (limited) return limited;

    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    const { ids, action } = parsed.data;

    // A second, per-ADMIN cap on the mailing action specifically. The IP bucket
    // above is shared by everyone behind one office NAT, and this is the action
    // whose cost lands on the sending domain rather than on this process.
    if (action === 'resend') {
      const perUser = rateLimit(`invitations-bulk-resend:${session.user.id}`, { limit: 6, windowMs: 60 * 60 * 1000 });
      if (!perUser.ok) {
        return NextResponse.json(
          { error: 'Too many bulk re-invites. Please try again later.', code: 'rate_limited' },
          { status: 429, headers: { 'Retry-After': String(perUser.retryAfter) } },
        );
      }
    }

    return await withTenantScope(session, async () => {
      const orgId = resolveOrgId(session);
      // The tenant filter IS the authorization check here: an id from another
      // org simply does not come back, and is reported as notFound.
      const rows = await prisma.invitationToken.findMany({
        where: orgScoped({ id: { in: ids } }, orgId),
        select: {
          id: true,
          token: true,
          email: true,
          label: true,
          role: true,
          used: true,
          expiresAt: true,
          openedAt: true,
          registeredAt: true,
          verifiedAt: true,
          revokedAt: true,
        },
      });

      const found = new Map(rows.map((r) => [r.id, r]));
      const now = new Date();
      const results: RowResult[] = ids
        .filter((id) => !found.has(id))
        .map((id) => ({ id, ok: false, outcome: 'notFound' as const, email: null, label: null }));

      const skip = (row: (typeof rows)[number], outcome: Outcome): RowResult => ({
        id: row.id,
        ok: false,
        outcome,
        email: row.email,
        label: row.label,
      });

      if (action === 'revoke') {
        const revocable: typeof rows = [];
        for (const row of rows) {
          const status = deriveInvitationStatus(row, now);
          if (!isInvitationRevocable(status)) {
            results.push(skip(row, status === 'revoked' ? 'skippedRevoked' : 'skippedRegistered'));
            continue;
          }
          revocable.push(row);
        }
        if (revocable.length > 0) {
          // One statement rather than a row-at-a-time loop: the org filter is
          // repeated here so the write can never widen what the read matched.
          await prisma.invitationToken.updateMany({
            where: orgScoped({ id: { in: revocable.map((r) => r.id) } }, orgId),
            data: { revokedAt: now },
          });
        }
        for (const row of revocable) {
          results.push({ id: row.id, ok: true, outcome: 'revoked', email: row.email, label: row.label });
        }
      } else if (action === 'delete') {
        const deletable: typeof rows = [];
        for (const row of rows) {
          // Deleting drops the audit trail, so only rows nobody ever touched
          // qualify. Anything that was opened or registered is revoked instead —
          // by the admin, deliberately, not silently by this branch.
          if (!isInvitationDeletable(row)) {
            results.push(skip(row, row.registeredAt || row.used ? 'skippedRegistered' : 'skippedOpened'));
            continue;
          }
          deletable.push(row);
        }
        if (deletable.length > 0) {
          await prisma.invitationToken.deleteMany({
            where: orgScoped({ id: { in: deletable.map((r) => r.id) } }, orgId),
          });
        }
        for (const row of deletable) {
          results.push({ id: row.id, ok: true, outcome: 'deleted', email: row.email, label: row.label });
        }
      } else {
        const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        const eligible: typeof rows = [];
        for (const row of rows) {
          const status = deriveInvitationStatus(row, now);
          if (!isInvitationResendable(status)) {
            results.push(skip(row, status === 'revoked' ? 'skippedRevoked' : 'skippedRegistered'));
            continue;
          }
          eligible.push(row);
        }

        const sent = await pooled(eligible, async (row): Promise<RowResult> => {
          // The expiry is refreshed for every eligible row, mailed or not: an
          // email-less shareable link (#670) has no delivery path at all, and a
          // synthetic demo address must not be mailed — but "give it another
          // week" is still exactly what the admin asked for.
          await prisma.invitationToken.update({ where: { id: row.id }, data: { expiresAt } });
          if (!row.email || isSyntheticInviteEmail(row.email)) {
            return { id: row.id, ok: true, outcome: 'refreshed', email: row.email, label: row.label };
          }
          let mailed = false;
          try {
            mailed =
              (await sendInvitationEmail({ to: row.email, token: row.token, role: row.role, orgId })) === 'SENT';
          } catch (mailErr) {
            // The token is still valid and the expiry is already refreshed, so a
            // failed send costs the batch nothing — it is reported as
            // "refreshed, not mailed" rather than failing the whole action.
            console.error('Bulk invitation resend failed (token still valid):', mailErr);
          }
          return {
            id: row.id,
            ok: true,
            outcome: mailed ? 'resent' : 'refreshed',
            email: row.email,
            label: row.label,
          };
        });
        results.push(...sent);
      }

      const changed = results.filter((r) => r.ok).length;
      await logActivity({
        action: `invitations.bulk.${action}`,
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        targetType: 'invitation',
        // Deliberately NOT the joined id list: ActivityLog.targetId is a plain
        // String column (VARCHAR) and 200 cuids overflow it — the insert then
        // throws inside logActivity's own catch and the audit line vanishes
        // silently, which is the one thing an audit line may not do.
        targetId: null,
        detail: `${changed}/${ids.length} updated`,
        request,
      });

      // Ordered the way the admin selected them, so the outcome list lines up
      // with the table they were looking at.
      const byId = new Map(results.map((r) => [r.id, r]));
      return NextResponse.json({
        ok: true,
        action,
        changed,
        skipped: results.length - changed,
        results: ids.map((id) => byId.get(id)).filter(Boolean),
      });
    });
  } catch (error) {
    console.error('Invitation bulk action error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
