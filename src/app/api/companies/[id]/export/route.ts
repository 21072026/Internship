import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import type { Prisma } from '@prisma/client';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { withTenantScope } from '@/lib/orgContext';
import { NO_MATCH, scopeForRole, logScopeDenial, andScope } from '@/lib/authzScope';
import { redactCompanyForReader } from '@/lib/companyVisibility';

/**
 * GET /api/companies/[id]/export — everything this installation holds about one
 * account, as one JSON file (#2435).
 *
 * "A customer asks what you have on them, or an account is handed over." Shaped
 * on `src/app/api/account/export/route.ts` (the GDPR self-service export): one
 * GET, one assembled payload, `Content-Disposition: attachment`, one audit row.
 * NO NEW TABLE — every section is read through relations that already exist.
 *
 * ── ACCESS ──────────────────────────────────────────────────────────────────
 * An export may never be broader than a read, so this route reuses BOTH halves
 * of the company read boundary rather than inventing a third rule:
 *   - WHICH ROW: `scopeForRole(user, 'company')` (#2430/#2431). A role with no
 *     builder (MENTEE, SOURCE) → 403 + an `authz.scope_denied` row; an id
 *     outside a defined scope → 404, the same answer a non-existent id gets.
 *     Exactly the split `GET /api/companies/[id]` uses.
 *   - WHICH COLUMNS: `redactCompanyForReader()` — vatId and the named contact's
 *     direct line stay ADMIN-only here too.
 *
 * ── WHICH SECTIONS, FOR WHOM ────────────────────────────────────────────────
 * Passing the row scope is not a licence to bundle up everything attached to
 * the row: a MENTOR legitimately reads a company through a relation, and would
 * otherwise receive — in one file — the requisitions, offers and shortlist that
 * `/api/requisitions`, `/api/offers` and `/api/company/interests` all refuse
 * them, plus the other mentors' mentees. So each section is gated by the read
 * right it already has elsewhere:
 *
 *   company, needs                     every reader that got past the scope
 *   relations, interactions,           the reader's OWN `relation` scope —
 *   statusChanges                      identical to the nested `mentorships`
 *                                      of the detail route
 *   requisitions, offers, interests    ADMIN + COMPANY (the two roles those
 *                                      three list routes admit; a COMPANY
 *                                      reader can only ever be here for its
 *                                      own row, which its company scope
 *                                      already guarantees)
 *   inquiries                          ADMIN only — an inbound enquiry carries
 *                                      a named person's e-mail and telephone
 *                                      number and NO read route returns it to
 *                                      anybody else today
 *
 * A section this reader may not have is `null`, never `[]`: "withheld" and
 * "there are none" are different facts, and a file that confuses them is a
 * file that quietly under-reports. `exportedBy.role` says which column of the
 * table above produced it.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const scope = await scopeForRole(session.user, 'company');
    if (!scope) {
      // The route PATTERN, not the requested id — an attacker-supplied string
      // has no business in `ActivityLog.targetId` (same as the detail route).
      await logScopeDenial(session.user, 'GET /api/companies/[id]/export');
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    // Fail-closed: every role that reaches this line has a `relation` builder,
    // so the fallback is a guard and not a path.
    const relationScope = (await scopeForRole(session.user, 'relation')) ?? { id: NO_MATCH };
    const role = session.user.role;
    const isAdmin = role === 'ADMIN';
    const readsAccountBook = isAdmin || role === 'COMPANY';

    return await withTenantScope(session, async () => {
      const company = await prisma.company.findFirst({ where: andScope(scope, { id }) });
      if (!company) {
        return NextResponse.json({ error: 'Company not found' }, { status: 404 });
      }

      const relations = await prisma.mentorshipRelation.findMany({
        where: andScope<Prisma.MentorshipRelationWhereInput>(relationScope, { companyId: company.id }),
        include: {
          mentor: { select: { id: true, fullName: true, email: true } },
          mentee: { select: { id: true, fullName: true, email: true } },
        },
        orderBy: { startDate: 'asc' },
      });
      const relationIds = relations.map((r) => r.id);
      const menteeIds = relations.map((r) => r.menteeId);
      // `{ in: [] }` matches nothing, which is the right answer for a reader
      // whose relation scope is empty — no branch needed.
      const throughRelations = { relationId: { in: relationIds } };

      const [needs, interactions, statusChanges, requisitions, offers, interests, inquiries] =
        await Promise.all([
          prisma.companyNeed.findMany({ where: { companyId: company.id } }),
          prisma.interactionLog.findMany({
            where: throughRelations,
            select: { id: true, relationId: true, date: true, type: true, subject: true, notes: true, autoLogged: true },
            orderBy: { date: 'asc' },
          }),
          prisma.statusChange.findMany({
            where: throughRelations,
            select: {
              id: true,
              relationId: true,
              fromStatus: true,
              toStatus: true,
              createdAt: true,
              reasonCode: true,
              reasonNote: true,
            },
            orderBy: { createdAt: 'asc' },
          }),
          readsAccountBook
            ? prisma.requisition.findMany({ where: { companyId: company.id }, orderBy: { createdAt: 'asc' } })
            : null,
          readsAccountBook
            ? prisma.offer.findMany({
                // An offer belongs to this account through either link; a row
                // whose company was set but whose relation moved is still this
                // account's history.
                where: { OR: [{ companyId: company.id }, throughRelations] },
                orderBy: { createdAt: 'asc' },
              })
            : null,
          readsAccountBook
            ? prisma.companyInterest.findMany({
                // ADMIN reads the whole shortlist; a COMPANY reader is on its
                // own row, so the extra term is a no-op for both — it is here
                // so a later role with a company scope cannot inherit the lot.
                where: isAdmin ? { companyId: company.id } : { companyId: company.id, menteeId: { in: menteeIds } },
                orderBy: { createdAt: 'asc' },
              })
            : null,
          isAdmin
            ? prisma.companyInquiry.findMany({
                where: { convertedCompanyId: company.id },
                orderBy: { createdAt: 'asc' },
              })
            : null,
        ]);

      await logActivity({
        action: 'company.export',
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        targetType: 'Company',
        targetId: company.id,
        detail: company.name,
        request,
      });

      // The drop-off note is free text written ABOUT the person whose stage
      // moved (#1801 makes "the reason is never read back to whoever it is
      // about" a rule): the CODE travels with the export, the prose is ADMIN's.
      const stageHistory = isAdmin
        ? statusChanges
        : statusChanges.map(({ reasonNote: _reasonNote, ...rest }) => rest);

      const payload = {
        exportedAt: new Date().toISOString(),
        exportedBy: { id: session.user.id, role },
        company: redactCompanyForReader(company, role),
        needs,
        relations,
        interactions,
        statusChanges: stageHistory,
        requisitions,
        offers,
        interests,
        inquiries,
      };
      return new NextResponse(JSON.stringify(payload, null, 2), {
        headers: {
          'Content-Type': 'application/json',
          // The id, never the name: a company name is free text and would put
          // whatever somebody typed — quotes, semicolons, a newline — into a
          // response header.
          'Content-Disposition': `attachment; filename="company-${company.id}.json"`,
        },
      });
    });
  } catch (error) {
    console.error('Company export error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
