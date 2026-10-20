import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/apiKey';
import { apiNotFound, apiOk } from '@/lib/api/v1';
import { interviewRequestSelect, serializeInterviewRequest } from '@/lib/api/v1Resources';

// GET /api/v1/interview-requests/{id} (#1990) — the same object as one element of
// the list. Another organisation's id is a 404, exactly like a missing one.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withApiKey(request, 'hiring:read', async (key) => {
    const row = await prisma.interviewRequest.findFirst({
      where: { AND: [{ id }, { orgId: key.orgId }] },
      select: interviewRequestSelect,
    });
    if (!row) return apiNotFound();
    return apiOk(serializeInterviewRequest(row));
  });
}
