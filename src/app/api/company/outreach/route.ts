import { NextResponse } from 'next/server';
import { requireCompanySeat } from '@/lib/companySeatGate';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { tenantAdminIds } from '@/lib/tenantAdmins';
import { prisma } from '@/lib/prisma';
import { COMPANY_NOT_VERIFIED, isCompanyVerified } from '@/lib/companyVerification';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { requireCapability } from '@/lib/capabilityGate';
import { enforceRateLimit } from '@/lib/rateLimit';
import { logActivity } from '@/lib/activity';
import { notify } from '@/lib/notify';
import { findActiveMentorship } from '@/lib/activeMentorship';
import { outreachQuota } from '@/lib/outreachQuota';
import { outreachActorWhere, outreachPreconditions, talentPoolIntroPreconditions } from '@/lib/outreach';
import { talentPoolVisibleWhere } from '@/lib/talentPool';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { hasFeature } from '@/lib/entitlements';
import { MAX_FIRST_MESSAGE, OUTREACH_SOURCES, companyView, requestRefusal } from '@/lib/outreachRule';

// Company → candidate message requests (#1840), docs/candidate-outreach.md.
//
// POST — a COMPANY user asks to message a candidate. Every precondition is
// checked HERE, from the database: shortlisted by this company, an active
// TALENT_POOL_VISIBILITY consent, no standing/cooled-down request, and the
// company under its monthly quota (403 { code: 'quota_exceeded', limit, used }
// so an upgrade prompt can render from the body). The first message is STORED
// on the row and delivered only when the candidate's active mentor or an
// admin approves (PATCH ./[id]). The mentor is told; the candidate is not —
// a pending request is invisible to them.
//
// GET — the requests the caller may see (outreachActorWhere): a company its
// own (status only — never who decided or why), a mentor the PENDING ones of
// the candidates they actively mentor, an admin the org's, a candidate their
// approved channels (to close them). FREE CORE: nothing here asks for a plan.

const bodySchema = z.strictObject({
  menteeId: z.string().min(1).max(64),
  message: z.string().trim().min(1).max(MAX_FIRST_MESSAGE),
  // The door (#1394): a shortlisted candidate (the default, #1840) or an
  // introduction asked from the talent-pool search.
  via: z.enum(OUTREACH_SOURCES).optional(),
});

const RATE_LIMIT = { limit: 30, windowMs: 60 * 60 * 1000 };
// Introductions from the pool, per COMPANY (every seat of it together): the
// pool is a list of strangers, so this door is metered harder than a shortlist.
const POOL_RATE_LIMIT = { limit: 20, windowMs: 24 * 60 * 60 * 1000 };

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const orgId = resolveOrgId(session);
  if (!orgId) return NextResponse.json({ requests: [] });
  const scope = outreachActorWhere({ role: session.user.role, userId: session.user.id, orgId, companyId: session.user.companyId });
  if (!scope) return NextResponse.json({ requests: [] });

  return withTenantScope(session, async () => {
    const role = session.user.role;
    // What each side has to act on: deciders the pending queue, the candidate
    // the open channels, the company the history of its own requests.
    const status = role === 'MENTOR' || role === 'ADMIN' ? 'PENDING' : role === 'MENTEE' ? 'APPROVED' : undefined;
    const rows = await prisma.candidateOutreach.findMany({
      where: { ...scope, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        menteeId: true,
        status: true,
        source: true,
        createdAt: true,
        decidedAt: true,
        firstMessage: true,
        conversationId: true,
        company: { select: { name: true } },
        mentee: { select: { fullName: true } },
      },
    });
    if (role === 'COMPANY') {
      return NextResponse.json({ requests: rows.map((r) => ({ ...companyView(r), menteeName: r.mentee.fullName })) });
    }
    return NextResponse.json({
      requests: rows.map((r) => ({
        id: r.id,
        status: r.status,
        source: r.source,
        createdAt: r.createdAt,
        company: r.company.name,
        // The candidate sees the company and the open thread; the deciders also
        // see who it is for and the stored first message they are approving.
        ...(role === 'MENTEE'
          ? { conversationId: r.conversationId }
          : { menteeId: r.menteeId, menteeName: r.mentee.fullName, firstMessage: r.firstMessage }),
      })),
    });
  });
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'COMPANY') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  // A shortlist is a placement step (#2364): the channel exists where placements do.
  const capGate = await requireCapability(session.user.orgId, 'placements');
  if (capGate) return capGate;
  const companyId = session.user.companyId;
  if (!companyId) return NextResponse.json({ error: 'Company assignment is required', code: 'company_not_assigned' }, { status: 403 });
  // Seats (#1870): the route refuses, never a hidden button.
  const seatGate = await requireCompanySeat(session, 'outreach.request');
  if (seatGate) return seatGate;
  const orgId = resolveOrgId(session);
  if (!orgId) return NextResponse.json({ error: 'Organization is required', code: 'organization_required' }, { status: 403 });
  const limited = enforceRateLimit(request, 'candidate-outreach', { ...RATE_LIMIT, subject: session.user.id });
  if (limited) return limited;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const { menteeId, message } = parsed.data;
  const source = parsed.data.via ?? 'SHORTLIST';
  if (source === 'TALENT_POOL') {
    // The pool's own gates (#1394), on top of the outreach ones: the seat that
    // may search it, the premium entitlement, and a per-company daily meter.
    const poolSeat = await requireCompanySeat(session, 'talentPool.search');
    if (poolSeat) return poolSeat;
    if (!(await hasFeature(companyId, 'TALENT_POOL_SEARCH'))) {
      return NextResponse.json({ error: 'feature_locked', code: 'feature_locked', feature: 'TALENT_POOL_SEARCH' }, { status: 403 });
    }
    const poolLimited = enforceRateLimit(request, 'candidate-outreach-pool', { ...POOL_RATE_LIMIT, subject: companyId });
    if (poolLimited) return poolLimited;
  }

  return withTenantScope(session, async () => {
    // An unverified employer reaches no candidate (#1865), this channel included.
    const employer = await prisma.company.findFirst({ where: { id: companyId, orgId }, select: { verificationStatus: true } });
    if (!isCompanyVerified(employer?.verificationStatus)) {
      return NextResponse.json({ error: 'The company is not verified yet', code: COMPANY_NOT_VERIFIED }, { status: 403 });
    }
    const pre =
      source === 'TALENT_POOL'
        ? await talentPoolIntroPreconditions(orgId, menteeId, await talentPoolVisibleWhere({ orgId, settingsOrgId: await settingsOrgOf(session), companyId, admin: false }))
        : await outreachPreconditions(orgId, companyId, menteeId);
    // Not shortlisted — or, from the pool, not in the pool this company may
    // search (another org, no opt-in, consent withdrawn) — answers like an
    // unknown candidate: the company learns nothing about that person.
    if (!pre.ok && (pre.code === 'not_shortlisted' || pre.code === 'not_in_pool')) return NextResponse.json({ error: 'Not found', code: pre.code }, { status: 404 });
    if (!pre.ok) return NextResponse.json({ error: 'The candidate is not open to company contact', code: pre.code }, { status: 403 });

    const existing = await prisma.candidateOutreach.findUnique({
      where: { companyId_menteeId: { companyId, menteeId } },
      select: { id: true, status: true, revokedAt: true },
    });
    const refusal = requestRefusal(existing, new Date());
    if (refusal) return NextResponse.json({ error: 'A request cannot be made now', code: refusal }, { status: 409 });

    const quota = await outreachQuota(orgId, companyId);
    if (quota.used >= quota.limit) {
      return NextResponse.json({ error: 'Monthly message request quota reached', code: 'quota_exceeded', limit: quota.limit, used: quota.used }, { status: 403 });
    }

    const data = {
      status: 'PENDING',
      source,
      requestedById: session.user.id,
      firstMessage: message,
      applicationId: pre.applicationId,
      decidedById: null,
      decidedAt: null,
      revokedAt: null,
      conversationId: null,
    };
    // One row per company × candidate: a repeat after a decline or an expired
    // cooldown reuses it — guarded on the status it was read in, so two tabs
    // cannot both reopen it.
    let id: string;
    if (existing) {
      const reopened = await prisma.candidateOutreach.updateMany({ where: { id: existing.id, status: existing.status }, data });
      if (reopened.count === 0) return NextResponse.json({ error: 'A request cannot be made now', code: 'pending' }, { status: 409 });
      id = existing.id;
    } else {
      try {
        id = (await prisma.candidateOutreach.create({ data: { ...data, orgId, companyId, menteeId }, select: { id: true } })).id;
      } catch {
        return NextResponse.json({ error: 'A request cannot be made now', code: 'pending' }, { status: 409 });
      }
    }

    const [mentorship, company, mentee] = await Promise.all([
      findActiveMentorship(prisma, menteeId),
      prisma.company.findUnique({ where: { id: companyId }, select: { name: true } }),
      prisma.user.findUnique({ where: { id: menteeId }, select: { fullName: true } }),
    ]);
    // The candidate's active mentor decides; without one, the org's admins do.
    const deciders = mentorship
      ? [mentorship.mentorId]
      : (await tenantAdminIds(orgId, { companyId })).slice(0, 20); // a PROGRAM_ADMIN only when its grant covers the company (#3485)
    for (const userId of deciders) {
      await notify(userId, 'outreach.requested', { company: company?.name ?? '', name: mentee?.fullName ?? '' }, '/messages');
    }
    await logActivity({
      action: 'outreach.requested',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'user',
      targetId: menteeId,
      orgId,
    });
    // The audit trail (#1394): every request, with its door. Never the message.
    await prisma.auditLog.create({ data: { actorId: session.user.id, action: 'OUTREACH_REQUESTED', targetId: id, orgId, detail: `source=${source}; mentee=${menteeId}` } });
    return NextResponse.json({ request: { id, status: 'PENDING' } }, { status: 201 });
  });
}
