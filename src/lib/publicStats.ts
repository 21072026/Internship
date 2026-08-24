import { prisma } from '@/lib/prisma';

// Live landing numbers (#1099): three counts and nothing else — the whole
// point is that they are computed, never hand-written into copy (§4.3), and
// they carry zero PII by construction.
export interface PublicStats {
  mentors: number;
  openProjects: number;
  waitingCandidates: number;
}

// Short in-memory cache: the landing is the most-hit page in the app and the
// numbers move slowly — three COUNT(*)s every request would be pure waste. A
// 10-minute staleness is invisible at this granularity; the cache is
// per-process, so a fresh deploy starts cold and that's fine.
const TTL_MS = 10 * 60 * 1000;
let cached: { at: number; stats: PublicStats } | null = null;

export async function getPublicStats(): Promise<PublicStats> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.stats;
  const [mentors, openProjects, waitingCandidates] = await Promise.all([
    prisma.user.count({ where: { role: 'MENTOR', isActive: true } }),
    prisma.project.count({ where: { isPublic: true, status: 'ACTIVE' } }),
    prisma.mentorshipRequest.count({ where: { status: 'PENDING' } }),
  ]);
  const stats = { mentors, openProjects, waitingCandidates };
  cached = { at: Date.now(), stats };
  return stats;
}
