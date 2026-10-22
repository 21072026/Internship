import { createHmac } from 'crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { requireServerSecret } from '@/lib/serverSecret';
import { clientIp, type HeaderSource } from '@/lib/clientIp';
import { agreementStatusOf, type AgreementStatus } from '@/lib/mentoringAgreementRule';
import { defaultOrgId } from '@/lib/defaultOrg';
import { orgWhere } from '@/lib/tenantFilter';
import { DEFAULT_AGREEMENT_AUTHORITATIVE, DEFAULT_AGREEMENT_BODY, DEFAULT_AGREEMENT_VERSION } from '@/lib/mentoringAgreementDefault';

/**
 * The mentoring agreement (#1790) — the contributor-terms design
 * (src/lib/contributorTerms.ts), per organisation. The same five properties:
 * the text is shown before the click, acceptance is an act, the text is
 * VERSIONED (a new version is new rows, never an edit — there is no update in
 * this file and the API refuses PATCH), evidence is stored hashed, and the
 * record can be read back. Enforcement at kickoff is #1792, not here.
 */

export const DEFAULT_AGREEMENT_KEY = 'default';
export const AGREEMENT_LOCALES = ['en', 'tr', 'de'] as const;
export type AgreementLocale = (typeof AGREEMENT_LOCALES)[number];

export interface ActiveAgreement {
  key: string;
  version: string;
  locale: string;
  isAuthoritative: boolean;
  body: string;
  effectiveFrom: Date;
  /** The locale that binds, when the reader is shown a translation. */
  authoritativeLocale: string | null;
}

/** A write the rules refuse — the route answers `status` with `code`. */
export class AgreementWriteError extends Error {
  constructor(public code: 'authoritative_missing' | 'body_required' | 'not_a_party' | 'stale_version' | 'no_agreement', public status: 400 | 403 | 409) {
    super(code);
  }
}

/**
 * The organisation an agreement row belongs to. A legacy NULL org reads as the
 * default org (src/lib/tenantFilter.ts), and agreement rows are never WRITTEN
 * with a NULL orgId: the deploy's backfill-organization.mjs moves NULL-org rows
 * into the default org, and a NULL-org v1 beside the default org's own v1 would
 * collide on @@unique([orgId, key, version, locale]) and fail the deploy.
 */
async function agreementOrg(orgId: string | null): Promise<string> {
  return orgId ?? (await defaultOrgId());
}

/**
 * Install the starter template as version 1 for an organisation that has no
 * agreement yet, so a fresh tenant is never staring at an empty editor. Safe to
 * call twice: the unique (org, key, version, locale) makes a racing second call
 * a no-op (skipDuplicates).
 */
export async function ensureDefaultAgreement(rawOrgId: string | null, key = DEFAULT_AGREEMENT_KEY): Promise<void> {
  const orgId = await agreementOrg(rawOrgId);
  if ((await prisma.mentoringAgreement.count({ where: { orgId, key } })) > 0) return;
  try {
    await prisma.mentoringAgreement.createMany({
      data: AGREEMENT_LOCALES.map((locale) => ({
        orgId,
        key,
        version: DEFAULT_AGREEMENT_VERSION,
        locale,
        isAuthoritative: locale === DEFAULT_AGREEMENT_AUTHORITATIVE,
        body: DEFAULT_AGREEMENT_BODY[locale],
        // Effective from the epoch: the template is in force from the moment it exists.
        effectiveFrom: new Date(0),
      })),
      skipDuplicates: true,
    });
  } catch (error) {
    // Another request installed it at the same moment (a deadlock on the
    // insert locks, P2034): the template exists either way. Anything else is real.
    if ((error as { code?: string })?.code !== 'P2034') throw error;
  }
}

/**
 * The agreement in force for an organisation, preferring the reader's locale
 * and falling back to the binding text rather than to nothing.
 */
export async function getActiveAgreement(rawOrgId: string | null, locale = 'en', now = new Date(), key = DEFAULT_AGREEMENT_KEY): Promise<ActiveAgreement | null> {
  const orgId = await agreementOrg(rawOrgId);
  await ensureDefaultAgreement(orgId, key);
  const rows = await prisma.mentoringAgreement.findMany({
    where: { orgId, key, effectiveFrom: { lte: now } },
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
  });
  if (rows.length === 0) return null;
  const newest = rows[0];
  const sameVersion = rows.filter((r) => r.version === newest.version);
  const authoritative = sameVersion.find((r) => r.isAuthoritative) ?? null;
  const chosen = sameVersion.find((r) => r.locale === locale) ?? authoritative ?? newest;
  return {
    key: chosen.key,
    version: chosen.version,
    locale: chosen.locale,
    isAuthoritative: chosen.isAuthoritative,
    body: chosen.body,
    effectiveFrom: chosen.effectiveFrom,
    authoritativeLocale: authoritative && authoritative.locale !== chosen.locale ? authoritative.locale : null,
  };
}

/** The exact text of one version — what an acceptance points at, years later. */
export async function agreementVersionText(rawOrgId: string | null, version: string, locale = 'en', key = DEFAULT_AGREEMENT_KEY) {
  const orgId = await agreementOrg(rawOrgId);
  const rows = await prisma.mentoringAgreement.findMany({ where: { orgId, key, version } });
  return rows.find((r) => r.locale === locale) ?? rows.find((r) => r.isAuthoritative) ?? rows[0] ?? null;
}

/** The next version number: versions are written by the server, never typed. */
export function nextAgreementVersion(existing: readonly string[]): string {
  const max = existing.reduce((m, v) => (/^\d+$/.test(v) ? Math.max(m, parseInt(v, 10)) : m), 0);
  return String(max + 1);
}

/**
 * Publish a NEW version: one row per given locale, exactly one authoritative.
 * There is deliberately no function here that changes an existing row.
 */
export async function publishAgreementVersion(
  rawOrgId: string | null,
  input: { bodies: Partial<Record<AgreementLocale, string>>; authoritativeLocale: AgreementLocale; effectiveFrom?: Date; createdById?: string | null },
  key = DEFAULT_AGREEMENT_KEY,
): Promise<{ version: string }> {
  const bodies = Object.entries(input.bodies).filter(([, b]) => typeof b === 'string' && b.trim()) as [AgreementLocale, string][];
  if (bodies.length === 0) throw new AgreementWriteError('body_required', 400);
  if (!bodies.some(([l]) => l === input.authoritativeLocale)) throw new AgreementWriteError('authoritative_missing', 400);
  const orgId = await agreementOrg(rawOrgId);
  await ensureDefaultAgreement(orgId, key);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.mentoringAgreement.findMany({ where: { orgId, key }, select: { version: true }, distinct: ['version'] });
    const version = nextAgreementVersion(existing.map((e) => e.version));
    await tx.mentoringAgreement.createMany({
      data: bodies.map(([locale, body]) => ({
        orgId,
        key,
        version,
        locale,
        isAuthoritative: locale === input.authoritativeLocale,
        body: body.trim(),
        effectiveFrom: input.effectiveFrom ?? new Date(),
        createdById: input.createdById ?? null,
      })),
    });
    return { version };
  });
}

/** Every version of an organisation's agreement, newest first, with its locales. */
export async function listAgreementVersions(rawOrgId: string | null, key = DEFAULT_AGREEMENT_KEY) {
  const orgId = await agreementOrg(rawOrgId);
  await ensureDefaultAgreement(orgId, key);
  const rows = await prisma.mentoringAgreement.findMany({ where: { orgId, key }, orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }] });
  const byVersion = new Map<string, { version: string; effectiveFrom: Date; createdAt: Date; texts: { locale: string; isAuthoritative: boolean; body: string }[] }>();
  for (const r of rows) {
    const v = byVersion.get(r.version) ?? { version: r.version, effectiveFrom: r.effectiveFrom, createdAt: r.createdAt, texts: [] };
    v.texts.push({ locale: r.locale, isAuthoritative: r.isAuthoritative, body: r.body });
    byVersion.set(r.version, v);
  }
  const counts = await prisma.mentoringAgreementAcceptance.groupBy({ by: ['version'], where: { agreementKey: key, relation: await orgWhere(orgId) }, _count: { _all: true } });
  const accepted = new Map(counts.map((c) => [c.version, c._count._all]));
  return [...byVersion.values()].map((v) => ({ ...v, acceptances: accepted.get(v.version) ?? 0 }));
}

export interface RelationAgreementState {
  required: boolean;
  version: string | null;
  mentorAcceptedAt: Date | null;
  menteeAcceptedAt: Date | null;
  bothAccepted: boolean;
}

/** Where a pairing stands against the agreement in force. Version-sensitive, like the terms. */
export async function agreementStateForRelation(relationId: string, now = new Date()): Promise<RelationAgreementState | null> {
  const rel = await prisma.mentorshipRelation.findUnique({ where: { id: relationId }, select: { id: true, orgId: true, mentorId: true, menteeId: true } });
  if (!rel) return null;
  const active = await getActiveAgreement(rel.orgId, 'en', now);
  if (!active) return { required: false, version: null, mentorAcceptedAt: null, menteeAcceptedAt: null, bothAccepted: true };
  const rows = await prisma.mentoringAgreementAcceptance.findMany({
    where: { relationId, agreementKey: active.key, version: active.version },
    select: { userId: true, acceptedAt: true },
  });
  const at = (userId: string) => rows.find((r) => r.userId === userId)?.acceptedAt ?? null;
  const mentorAcceptedAt = at(rel.mentorId);
  const menteeAcceptedAt = at(rel.menteeId);
  return { required: true, version: active.version, mentorAcceptedAt, menteeAcceptedAt, bothAccepted: !!mentorAcceptedAt && !!menteeAcceptedAt };
}

function evidenceHash(value: string | null | undefined): string | null {
  if (!value) return null;
  return createHmac('sha256', requireServerSecret()).update(value).digest('hex').slice(0, 32);
}

/**
 * Record that `userId` accepted `version` for this pairing. Only a party may
 * accept, only the version in force (a stale page is 409), and re-accepting
 * never moves `acceptedAt` — the first time they agreed is the fact the record
 * keeps. The unique (relationId, userId, version) has no NULL column, so a race
 * resolves to the one row.
 */
export async function acceptAgreement(input: { relationId: string; userId: string; version: string; locale?: string; request?: HeaderSource }) {
  const rel = await prisma.mentorshipRelation.findUnique({ where: { id: input.relationId }, select: { orgId: true, mentorId: true, menteeId: true } });
  if (!rel) throw new AgreementWriteError('not_a_party', 403);
  const role = rel.mentorId === input.userId ? 'MENTOR' : rel.menteeId === input.userId ? 'MENTEE' : null;
  if (!role) throw new AgreementWriteError('not_a_party', 403);
  const active = await getActiveAgreement(rel.orgId, input.locale ?? 'en');
  if (!active) throw new AgreementWriteError('no_agreement', 409);
  if (active.version !== input.version) throw new AgreementWriteError('stale_version', 409);

  const where = { relationId_userId_version: { relationId: input.relationId, userId: input.userId, version: active.version } };
  const existing = await prisma.mentoringAgreementAcceptance.findUnique({ where });
  if (existing) return existing;
  const ip = input.request ? clientIp(input.request) : null;
  const ua = input.request?.headers.get('user-agent') ?? null;
  try {
    return await prisma.mentoringAgreementAcceptance.create({
      data: {
        relationId: input.relationId,
        userId: input.userId,
        agreementKey: active.key,
        version: active.version,
        role,
        locale: input.locale ?? null,
        ipHash: evidenceHash(ip),
        uaHash: evidenceHash(ua),
      },
    });
  } catch (error) {
    if ((error as { code?: string })?.code === 'P2002') return prisma.mentoringAgreementAcceptance.findUniqueOrThrow({ where });
    throw error;
  }
}

/**
 * The admin list: every ACTIVE pairing of the organisation and whether each
 * side accepted the version in force. The fuller "who has not signed" screen is
 * #1792; this is its data.
 */
export async function acceptanceReport(rawOrgId: string | null, now = new Date()) {
  const orgId = await agreementOrg(rawOrgId);
  const active = await getActiveAgreement(orgId, 'en', now);
  // The default org's report includes its legacy NULL-org relations.
  const relations = await prisma.mentorshipRelation.findMany({
    where: { AND: [await orgWhere(orgId), { status: 'ACTIVE' }] },
    select: { id: true, mentorId: true, menteeId: true, mentor: { select: { fullName: true } }, mentee: { select: { fullName: true } } },
    orderBy: { startDate: 'desc' },
  });
  const rows = active
    ? await prisma.mentoringAgreementAcceptance.findMany({
        where: { relationId: { in: relations.map((r) => r.id) }, agreementKey: active.key, version: active.version },
        select: { relationId: true, userId: true, acceptedAt: true },
      })
    : [];
  const at = (relationId: string, userId: string) => rows.find((r) => r.relationId === relationId && r.userId === userId)?.acceptedAt ?? null;
  return {
    version: active?.version ?? null,
    relations: relations.map((r) => {
      const mentorAcceptedAt = at(r.id, r.mentorId);
      const menteeAcceptedAt = at(r.id, r.menteeId);
      return { relationId: r.id, mentorName: r.mentor.fullName, menteeName: r.mentee.fullName, mentorAcceptedAt, menteeAcceptedAt, bothAccepted: !!mentorAcceptedAt && !!menteeAcceptedAt };
    }),
  };
}

// ── Kickoff (#1792) ──────────────────────────────────────────────────────────
// A PROMPT, NOT A GATE: everything below reports and records. No caller may use
// a missing acceptance to disable messaging, meetings, goals, the portal or the
// pipeline (see src/lib/mentoringAgreementRule.ts).

/**
 * The `agreement` block of GET /api/mentorship/[id]: the version in force, its
 * text in the viewer's language (the binding text when there is no
 * translation), each side's acceptance, and whether the viewer accepted an
 * EARLIER version — the "the agreement has been updated" prompt.
 */
export async function agreementBlockFor(relationId: string, viewerId: string, locale: string) {
  const rel = await prisma.mentorshipRelation.findUnique({ where: { id: relationId }, select: { orgId: true, mentorId: true, menteeId: true } });
  if (!rel) return null;
  const active = await getActiveAgreement(rel.orgId, locale);
  if (!active) return null;
  const rows = await prisma.mentoringAgreementAcceptance.findMany({
    where: { relationId, agreementKey: active.key },
    select: { userId: true, version: true, acceptedAt: true },
  });
  const current = (userId: string) => rows.find((r) => r.userId === userId && r.version === active.version)?.acceptedAt ?? null;
  const mentorAcceptedAt = current(rel.mentorId);
  const menteeAcceptedAt = current(rel.menteeId);
  const seat: 'MENTOR' | 'MENTEE' | null = viewerId === rel.mentorId ? 'MENTOR' : viewerId === rel.menteeId ? 'MENTEE' : null;
  return {
    version: active.version,
    locale: active.locale,
    authoritativeLocale: active.authoritativeLocale,
    body: active.body,
    mentorAcceptedAt: mentorAcceptedAt?.toISOString() ?? null,
    menteeAcceptedAt: menteeAcceptedAt?.toISOString() ?? null,
    status: agreementStatusOf(mentorAcceptedAt, menteeAcceptedAt),
    seat,
    viewerAcceptedAt: seat ? (current(viewerId)?.toISOString() ?? null) : null,
    viewerAcceptedEarlier: seat ? rows.some((r) => r.userId === viewerId && r.version !== active.version) : false,
  };
}

/**
 * The admin list filter: relations of one org in `status` against `version`.
 * Keyed on the acceptance's recorded side (MENTOR/MENTEE), so it is one SQL
 * predicate rather than a page of rows filtered in memory.
 */
export function agreementStatusWhere(status: AgreementStatus, version: string, key = DEFAULT_AGREEMENT_KEY): Prisma.MentorshipRelationWhereInput {
  const side = (role: 'MENTOR' | 'MENTEE') => ({ agreementAcceptances: { some: { agreementKey: key, version, role } } });
  const noSide = (role: 'MENTOR' | 'MENTEE') => ({ agreementAcceptances: { none: { agreementKey: key, version, role } } });
  if (status === 'SIGNED') return { AND: [side('MENTOR'), side('MENTEE')] };
  if (status === 'MENTOR_ONLY') return { AND: [side('MENTOR'), noSide('MENTEE')] };
  if (status === 'MENTEE_ONLY') return { AND: [noSide('MENTOR'), side('MENTEE')] };
  return { AND: [noSide('MENTOR'), noSide('MENTEE')] };
}

/** Each relation's status against the version in force for its org — the admin list's column. */
export async function agreementStatusesFor(relations: readonly { id: string; orgId: string | null }[]): Promise<Map<string, AgreementStatus>> {
  const out = new Map<string, AgreementStatus>();
  const byOrg = new Map<string | null, string[]>();
  for (const r of relations) byOrg.set(r.orgId, [...(byOrg.get(r.orgId) ?? []), r.id]);
  for (const [orgId, ids] of byOrg) {
    const active = await getActiveAgreement(orgId);
    if (!active) continue;
    const rows = await prisma.mentoringAgreementAcceptance.findMany({
      where: { relationId: { in: ids }, agreementKey: active.key, version: active.version },
      select: { relationId: true, role: true },
    });
    for (const id of ids) {
      const mine = rows.filter((r) => r.relationId === id);
      out.set(id, agreementStatusOf(mine.some((r) => r.role === 'MENTOR'), mine.some((r) => r.role === 'MENTEE')));
    }
  }
  return out;
}
