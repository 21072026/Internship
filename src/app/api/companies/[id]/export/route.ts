import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import type { Prisma } from '@prisma/client';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { logger } from '@/lib/logger';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { withRequestScope } from '@/lib/requestContext';
import { scopeForRole, logScopeDenial, andScope } from '@/lib/authzScope';
import { redactCompanyForReader } from '@/lib/companyVisibility';
import { transliterate } from '@/lib/transliterate';

/**
 * GET /api/companies/[id]/export — everything this installation holds about one
 * company, as one JSON file (#2435).
 *
 * "A customer asks what we hold on them, or an account is handed over." Shaped
 * on `src/app/api/account/export/route.ts` (the GDPR self-service export): one
 * GET, one assembled payload, `Content-Disposition: attachment`, one audit row.
 * NO NEW TABLE: every section is read through relations that already exist.
 *
 * ── WHO ─────────────────────────────────────────────────────────────────────
 * ADMIN only. Every other role gets 403 plus an `authz.scope_denied` row
 * (`logScopeDenial`, the route PATTERN as target, never the requested id),
 * before any company is looked up, so the answer says nothing about the id.
 *
 * Why not "every role that may read the company, with a narrower file": that
 * was the first draft on `feat/2396-company-audit-erasure-export`, and the one
 * section that looked harmless proved the point. It handed a COMPANY reader
 * its whole `Offer` rows, DRAFTs and `compensationNote` included, which
 * `GET /api/offers` withholds from exactly that role (`canSeeCompensation`,
 * `status: { not: 'DRAFT' }`). A per-role export has to re-prove every column
 * of every section against every read route, and has to be re-proved each time
 * one of them narrows. The operator is the only reader the use case has, so
 * the operator is the only reader the route serves. An impersonated session is
 * refused as well: it carries the target's role, and ADMIN accounts cannot be
 * impersonated (`/api/admin/impersonate`), so it cannot pass today; the gate
 * asserts it anyway, like the erase route does, so a file is never attributed
 * to the account an admin was merely looking through.
 *
 * ── WHICH COMPANY ───────────────────────────────────────────────────────────
 * The same boundary as `GET /api/companies/[id]`, so the file is never broader
 * than the read:
 *   - ROW SCOPE: `scopeForRole(user, 'company')` (#2431). ADMIN's `{}` today,
 *     composed with `andScope`, so a later narrower ADMIN builder narrows the
 *     export too.
 *   - ORG SCOPE: `withinTenant(…, await tenantWhere(session))`, flag-independent —
 *     the #2542 rule in src/lib/tenantFilter.ts, the same call the detail read
 *     makes. With `MT_ENFORCE_ISOLATION` off, which is every deployment today,
 *     the middleware filters nothing, and this hand-written term is the only
 *     thing between an admin of one tenant and another tenant's account book.
 *     Another org's company is a 404, the same answer a missing id gets. A
 *     NULL-org row is the default org's (the deploy backfill's rule), and a
 *     session without an org reads as the default org's, never as unscoped.
 *
 * ── WHAT IS IN THE FILE ─────────────────────────────────────────────────────
 * The sections #2435 lists, each reached from the company already verified:
 *   company        the row (`redactCompanyForReader`: a no-op for ADMIN, kept
 *                  so the column layer stays the one in companyVisibility.ts)
 *   needs          CompanyNeed
 *   requisitions   Requisition
 *   offers         Offer with `companyId` = this company, plus an offer with
 *                  NO company on one of its relations. An offer naming ANOTHER
 *                  company on a relation that sits here is that company's
 *                  commercial history, and stays out of this one's file.
 *   interests      CompanyInterest (the shortlist)
 *   inquiries      CompanyInquiry this company was converted from (#1863)
 *   relations      MentorshipRelation at this company, through the reader's
 *                  `relation` scope, with mentor/mentee id + name + e-mail
 *                  only (never a whole User row)
 *   interactions   InteractionLog of those relations
 *   statusChanges  StatusChange of those relations
 * Child rows are not filtered by their own `orgId`: the account is the tenant
 * boundary here, and a child row with a stale or missing stamp must not drop
 * out of the file silently. With the flag on, the middleware filters them all
 * the same.
 *
 * Deliberately NOT in the file: `placements` (the programme's own fee and value
 * figures, not the customer's data), `usage` (feed volume, unbounded), the
 * company logins (User rows, each with its own `/api/account/export`), and
 * `entitlements`/`needAlerts`/`interviewRequests`/`projects`. Adding one is a
 * decision for this list, not a side effect of an `include`.
 *
 * ── AUDIT ───────────────────────────────────────────────────────────────────
 * Every served file writes one `company.export` row through `logActivity()`,
 * with no repeat suppression: a second download is a second copy leaving the
 * system. No company name in `detail`, for the reason `company.view` has none
 * (src/lib/viewLogRule.ts): the activity feed is not tenant-scoped yet. A 404
 * exported nothing and writes nothing.
 */

/** Logged as the denial target: the pattern, never an attacker-chosen id. */
const ROUTE = 'GET /api/companies/[id]/export';

/** Who is named on a relation: enough to read the file, never a whole User row. */
const PERSON = { select: { id: true, fullName: true, email: true } } as const;

/**
 * `company-<name-slug>-<id>.json`. The slug is `[a-z0-9-]` only, so a company
 * name — free text — cannot put a quote, a semicolon or a newline into the
 * response header; the id alone keeps two accounts of the same name apart.
 */
function exportFilename(company: { id: string; name: string }): string {
  const slug = transliterate(company.name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');
  const id = company.id.replace(/[^A-Za-z0-9_-]/g, '');
  return `company-${slug ? `${slug}-` : ''}${id}.json`;
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  // Request id bound outside the tenant scope (#1601), so both contexts are
  // established at the top of the handler and every log line carries it.
  return withRequestScope(request, () => handleGet(request, context));
}

async function handleGet(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const isOperator = session.user.role === 'ADMIN' && !session.user.impersonatorId;
    const scope = isOperator ? await scopeForRole(session.user, 'company') : null;
    const relationScope = scope ? await scopeForRole(session.user, 'relation') : null;
    if (!scope || !relationScope) {
      await logScopeDenial(session.user, ROUTE);
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const tenant = await tenantWhere(session);

    return await withTenantScope(session, async () => {
      const company = await prisma.company.findFirst({
        where: andScope<Prisma.CompanyWhereInput>(scope, withinTenant({ id }, tenant)),
      });
      if (!company) {
        return NextResponse.json({ error: 'Company not found' }, { status: 404 });
      }

      const relations = await prisma.mentorshipRelation.findMany({
        where: andScope<Prisma.MentorshipRelationWhereInput>(relationScope, { companyId: company.id }),
        include: { mentor: PERSON, mentee: PERSON },
        orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
      });
      // `{ in: [] }` matches nothing, which is the right answer for a company
      // with no relations — no branch needed.
      const relationIds = relations.map((r) => r.id);
      const throughRelations = { relationId: { in: relationIds } };

      const [needs, requisitions, offers, interests, inquiries, interactions, statusChanges] = await Promise.all([
        prisma.companyNeed.findMany({ where: { companyId: company.id }, orderBy: { id: 'asc' } }),
        prisma.requisition.findMany({
          where: { companyId: company.id },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
        prisma.offer.findMany({
          where: { OR: [{ companyId: company.id }, { companyId: null, ...throughRelations }] },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
        prisma.companyInterest.findMany({
          where: { companyId: company.id },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
        prisma.companyInquiry.findMany({
          where: { convertedCompanyId: company.id },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
        prisma.interactionLog.findMany({ where: throughRelations, orderBy: [{ date: 'asc' }, { id: 'asc' }] }),
        prisma.statusChange.findMany({ where: throughRelations, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
      ]);

      const body = JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          company: redactCompanyForReader(company, session.user.role),
          needs,
          requisitions,
          offers,
          interests,
          inquiries,
          relations,
          interactions,
          statusChanges,
        },
        null,
        2
      );

      // Written once the file exists and before it leaves: an export that
      // failed to assemble sent nothing, and one that is sent is on record.
      await logActivity({
        action: 'company.export',
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        targetType: 'company',
        targetId: company.id,
        request,
      });

      return new NextResponse(body, {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="${exportFilename(company)}"`,
          // A customer's whole record: nothing between here and the browser
          // keeps a copy.
          'Cache-Control': 'no-store',
        },
      });
    });
  } catch (error) {
    logger.error('Company export error', { error: String(error) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
