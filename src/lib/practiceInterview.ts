// Practice interview (#2051) — the server reads: what the interview is about,
// and a session as the mentee's screen sees it. Server-only.

import { prisma } from '@/lib/prisma';
import { readTurns, type PracticeTurn } from '@/lib/practiceInterviewRules';
import type { PracticeContext } from '@/lib/ai/practiceInterview';

/**
 * What the interview is grounded in: a requisition the mentee is connected to
 * (a kept company interest or an interview request — the same rule as the CV
 * review's tailoring, src/lib/cvReview.ts), else their own target position.
 * null when neither exists, or the requisition is not theirs to use.
 */
export async function practiceContext(userId: string, requisitionId: string | null): Promise<(PracticeContext & { requisitionId: string | null }) | null> {
  const me = await prisma.user.findUnique({ where: { id: userId }, select: { targetPosition: true, skills: true } });
  const skills = (Array.isArray(me?.skills) ? me!.skills : []).filter((s): s is string => typeof s === 'string').slice(0, 30);
  if (requisitionId) {
    const r = await prisma.requisition.findFirst({
      where: {
        id: requisitionId,
        status: { notIn: ['DRAFT', 'CANCELLED'] },
        OR: [{ interests: { some: { menteeId: userId, status: { not: 'PASS' } } } }, { interviewRequests: { some: { menteeId: userId } } }],
      },
      select: { id: true, title: true, description: true, requiredSkills: true },
    });
    if (!r) return null;
    const required = (Array.isArray(r.requiredSkills) ? r.requiredSkills : []).filter((s): s is string => typeof s === 'string');
    return { role: r.title, skills, requisitionText: `${r.title}\nRequired skills: ${required.join(', ') || '—'}\n${r.description ?? ''}`, requisitionId: r.id };
  }
  const role = (me?.targetPosition ?? '').trim();
  return role ? { role, skills, requisitionText: null, requisitionId: null } : null;
}

export interface PracticeSessionView {
  id: string;
  role: string;
  status: string;
  maxTurns: number;
  turns: PracticeTurn[];
  reportArtifactId: string | null;
  startedAt: string;
  endedAt: string | null;
}

export function toSessionView(s: { id: string; role: string; status: string; maxTurns: number; turns: unknown; reportArtifactId: string | null; startedAt: Date; endedAt: Date | null }): PracticeSessionView {
  return {
    id: s.id,
    role: s.role,
    status: s.status,
    maxTurns: s.maxTurns,
    turns: readTurns(s.turns),
    reportArtifactId: s.reportArtifactId,
    startedAt: s.startedAt.toISOString(),
    endedAt: s.endedAt?.toISOString() ?? null,
  };
}
