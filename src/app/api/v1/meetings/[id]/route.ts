import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/apiKey';
import { apiNotFound, apiOk } from '@/lib/api/v1';
import { meetingSelect, serializeMeeting, meetingOrgWhere } from '@/lib/api/v1Resources';

// GET /api/v1/meetings/{id} (#1990) — the same object as one element of
// the list. Another organisation's id is a 404, exactly like a missing one.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withApiKey(request, 'meetings:read', async (key) => {
    const row = await prisma.meeting.findFirst({
      where: { AND: [{ id }, meetingOrgWhere(key.orgId)] },
      select: meetingSelect,
    });
    if (!row) return apiNotFound();
    return apiOk(serializeMeeting(row));
  });
}
