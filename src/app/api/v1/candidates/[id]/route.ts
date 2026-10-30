import { prisma } from '@/lib/prisma';
import { sourceOnly, withApiKey } from '@/lib/apiKey';
import { apiNotFound, apiOk } from '@/lib/api/v1';
import { apiWrite, writeOk } from '@/lib/api/v1Write';
import { candidateSelect, serializeCandidate } from '@/lib/api/v1Resources';
import { checkSkills, updateCandidateSchema } from '@/lib/api/v1Candidates';
import { planFieldUpdates } from '@/lib/externalSyncPolicy';

// GET /api/v1/candidates/{id} — the same object as one element of the list.
// Another organisation's id, or an account that is not a candidate, is a 404.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withApiKey(request, 'candidates:read', async (key) => {
    const row = await prisma.user.findFirst({ where: { id, role: 'MENTEE', orgId: key.orgId, ...sourceOnly(key) }, select: candidateSelect });
    if (!row) return apiNotFound();
    return apiOk(serializeCandidate(row));
  }, { sourceScoped: true });
}

// PATCH /api/v1/candidates/{id} (#1996) — the profile fields the read endpoint
// exposes, nothing else (`.strict()`: role, orgId, e-mail and every credential
// field are refused with a 422, not ignored). What an external system may
// overwrite is decided by the ONE policy SSO sync and the roster feed share
// (src/lib/externalSyncPolicy.ts); an explicit PATCH is authoritative for the
// fields it names, and a blank value is "no opinion" — a PATCH cannot empty a
// field a person filled in.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withApiKey(request, 'candidates:write', (key) =>
    apiWrite(request, key, updateCandidateSchema, async (body) => {
      const current = await prisma.user.findFirst({
        where: { id, role: 'MENTEE', orgId: key.orgId },
        select: { fullName: true, university: true, department: true, graduationYear: true },
      });
      if (!current) return apiNotFound();
      const skills = checkSkills(body.skills);
      if (skills instanceof Response) return skills;

      const { skills: _skills, ...scalars } = body;
      const plan = planFieldUpdates(current, scalars, { authoritative: true });
      const updated = await prisma.user.update({
        where: { id },
        data: { ...plan.changes, ...(skills ? { skills } : {}) },
        select: candidateSelect,
      });
      const changed = [...plan.changed, ...(skills ? ['skills'] : [])];
      return writeOk(apiOk(serializeCandidate(updated)), {
        action: 'api.candidate.update',
        targetType: 'user',
        targetId: id,
        detail: changed.length ? `changed ${changed.join(', ')}` : 'no change',
      });
    }),
  );
}
