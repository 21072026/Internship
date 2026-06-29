// Lightweight, deterministic heuristics for mentor suggestions and the
// "next action" hint. No ML — just skill overlap + capacity + recency.

export interface MentorCandidate {
  id: string;
  fullName: string;
  skills: string[];
  activeCount: number;
  capacity?: number | null;
}

const norm = (s: string) => s.trim().toLowerCase();

export function scoreMentors(menteeSkills: string[], mentors: MentorCandidate[]) {
  const want = [...new Set(menteeSkills.map(norm).filter(Boolean))];
  return mentors
    .map((m) => {
      const owned = m.skills.map(norm).filter(Boolean);
      // Substring match so "react" overlaps "React.js" (mirrors candidate search).
      const overlap = want.filter((w) => owned.some((o) => o === w || o.includes(w) || w.includes(o))).length;
      const atCapacity = m.capacity != null && m.capacity > 0 && m.activeCount >= m.capacity;
      // Skill overlap dominates; lighter load breaks ties; full mentors sink.
      const score = overlap * 10 - m.activeCount - (atCapacity ? 1000 : 0);
      return { id: m.id, fullName: m.fullName, overlap, activeCount: m.activeCount, capacity: m.capacity ?? null, atCapacity, score };
    })
    .sort((a, b) => b.score - a.score);
}

export interface NextActionInput {
  pipelineStatus: string;
  lastInteractionAt?: Date | string | null;
}

// Returns a short suggested next action + a severity level.
export function nextAction({ pipelineStatus, lastInteractionAt }: NextActionInput): {
  text: string;
  level: 'ok' | 'warn' | 'urgent';
} {
  const last = lastInteractionAt ? new Date(lastInteractionAt) : null;
  const days = last ? Math.floor((Date.now() - last.getTime()) / 86_400_000) : null;

  if (days === null) return { text: 'Log a first interaction', level: 'warn' };
  if (days >= 21) return { text: `No contact in ${days} days — reach out`, level: 'urgent' };
  if (days >= 14) return { text: `Last contact ${days} days ago — follow up`, level: 'warn' };

  const ending = ['INTERNSHIP_COMPLETED_490', 'JOB_SEEKING_500', 'HIREABLE_600'];
  if (ending.includes(pipelineStatus)) return { text: 'Push toward hiring', level: 'warn' };
  return { text: 'On track', level: 'ok' };
}
