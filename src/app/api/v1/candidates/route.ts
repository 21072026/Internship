import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/apiKey';
import { KEYSET_ORDER, apiOk, keysetWhere, paginate, parseListQuery } from '@/lib/api/v1';

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
      select: {
        id: true,
        fullName: true,
        university: true,
        department: true,
        graduationYear: true,
        skills: true,
        createdAt: true,
        updatedAt: true,
        menteeRelations: { where: { status: 'ACTIVE' }, take: 1, select: { pipelineStatus: true } },
      },
    });
    const { rows, page } = paginate(RESOURCE, mentees, query.limit);

    const data = rows.map((m) => ({
      id: m.id,
      fullName: m.fullName,
      university: m.university,
      department: m.department,
      graduationYear: m.graduationYear,
      skills: m.skills,
      stage: m.menteeRelations[0]?.pipelineStatus ?? null,
      createdAt: m.createdAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
    }));
    return apiOk(data, page, { candidates: data });
  });
}
