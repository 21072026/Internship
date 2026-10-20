import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/apiKey';
import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { KEYSET_ORDER, apiError, apiOk, keysetWhere, paginate, parseListQuery } from '@/lib/api/v1';
import { apiWrite, writeOk } from '@/lib/api/v1Write';
import { candidateSelect, serializeCandidate } from '@/lib/api/v1Resources';
import { checkSkills, createCandidateSchema } from '@/lib/api/v1Candidates';
import { findPossibleDuplicates } from '@/lib/duplicateDetection';
import { findUsersInWorld, worldOfOrg } from '@/lib/userWorld';

// Public, read-only programmatic API authenticated with a Bearer API key.
// Returns a candidate (mentee) summary — no contact PII.
//
// Everything about the credential — is it live, does it hold `candidates:read`,
// which organisation is it — is decided by withApiKey() before this body runs
// (#1546). What is left here is the query, and the query is scoped EXPLICITLY
// by the key's org: the tenant middleware only engages when
// MT_ENFORCE_ISOLATION is on, and a cross-tenant read must not wait for a flag.
//
// The shape is the v1 contract (#1988, src/lib/api/v1.ts): `{ data, page }`,
// a keyset cursor over (updatedAt, id) and `?updatedSince=`. The pre-#1988
// `candidates` key is kept as a deprecated alias of `data` until 2027-01-31
// (published in the OpenAPI document and docs/public-api.md). Not a
// `Deprecation` header: that would mark the whole endpoint, not one key.
const RESOURCE = 'candidates';

export async function GET(request: Request) {
  return withApiKey(request, 'candidates:read', async (key) => {
    const query = parseListQuery(request, RESOURCE);
    if (query instanceof Response) return query;

    const mentees = await prisma.user.findMany({
      where: { role: 'MENTEE', orgId: key.orgId, ...keysetWhere(query) },
      orderBy: KEYSET_ORDER,
      take: query.limit + 1,
      select: candidateSelect,
    });
    const { rows, page } = paginate(RESOURCE, mentees, query.limit);
    const data = rows.map(serializeCandidate);
    return apiOk(data, page, { candidates: data });
  });
}

// POST /api/v1/candidates (#1996) — create a mentee in the key's org.
//
// Never a near-duplicate: an e-mail already in use in this product's world is
// always a 409 `duplicate_candidate` (with the id only when the match is in
// the key's own org — another tenant's account is not named), and a look-alike
// by the shared duplicate rule (src/lib/duplicateDetection.ts, the one the CSV
// import and /admin/duplicates use) is a 409 with the matches unless the caller
// sends `allowPossibleDuplicate: true`. The account gets a password nobody
// knows, exactly like a CSV-imported one: it is claimed through a reset.
export async function POST(request: Request) {
  return withApiKey(request, 'candidates:write', (key) =>
    apiWrite(request, key, createCandidateSchema, async (body) => {
      const skills = checkSkills(body.skills);
      if (skills instanceof Response) return skills;

      const existing = await findUsersInWorld(body.email, await worldOfOrg(key.orgId), { id: true, orgId: true });
      if (existing.length > 0) {
        const mine = existing.find((u) => u.orgId === key.orgId);
        return apiError(409, 'duplicate_candidate', 'This candidate already exists', 'An account with this e-mail address already exists.', {
          matches: mine ? [{ id: mine.id, signals: ['email'] }] : [],
        });
      }
      if (!body.allowPossibleDuplicate) {
        const matches = await findPossibleDuplicates({ fullName: body.fullName, email: body.email, university: body.university, orgId: key.orgId });
        if (matches.length > 0) {
          return apiError(409, 'duplicate_candidate', 'A similar candidate already exists', 'Resend with allowPossibleDuplicate: true to create it anyway.', {
            matches: matches.slice(0, 5).map((m) => ({ id: m.id, signals: m.signals, score: m.score })),
          });
        }
      }

      const created = await prisma.user.create({
        data: {
          email: body.email,
          fullName: body.fullName,
          university: body.university ?? null,
          department: body.department ?? null,
          graduationYear: body.graduationYear ?? null,
          ...(skills ? { skills } : {}),
          password: await bcrypt.hash(randomBytes(18).toString('hex'), 10),
          role: 'MENTEE',
          orgId: key.orgId,
        },
        select: candidateSelect,
      });
      return writeOk(apiOk(serializeCandidate(created), undefined, undefined, { status: 201 }), {
        action: 'api.candidate.create',
        targetType: 'user',
        targetId: created.id,
      });
    }),
  );
}
