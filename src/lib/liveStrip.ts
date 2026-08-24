// Pure helper for the landing's live status strip (#1099), separated from
// publicStats so tests (and any client code) can import it without dragging
// the Prisma client along.
import type { PublicStats } from '@/lib/publicStats';

// The strip's pieces, zero-hidden (#1099 rule: a "0 open projects" chip is
// worse than no chip; all three at zero → no strip at all). Pure so the
// zero-hiding rule is unit-testable without a database.
export function buildLiveStripPieces(
  stats: PublicStats,
  templates: { mentors: string; openProjects: string; waitingCandidates: string }
): string[] {
  const pieces: string[] = [];
  if (stats.mentors > 0) pieces.push(templates.mentors.replace('{n}', String(stats.mentors)));
  if (stats.openProjects > 0) pieces.push(templates.openProjects.replace('{n}', String(stats.openProjects)));
  if (stats.waitingCandidates > 0) pieces.push(templates.waitingCandidates.replace('{n}', String(stats.waitingCandidates)));
  return pieces;
}
