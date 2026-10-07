// AI-deepened mentor↔mentee matching (Faz 2, #533). Privacy by design: the
// provider never sees personal identifiers — mentors are sent as anonymous
// labels (A, B, C…) with skills/interests/load only, and the mentee as an
// unnamed profile. Labels are mapped back to mentor ids locally. Callers MUST
// go through runAiGated (quota); with no provider the rule-based ranking is
// returned unchanged (graceful fallback). The prompt and the parser are here;
// the client, model and timeout are callModel's (#2022, task `mentor_match`).

import { z } from 'zod';
import { callModel, safeParseModelJson } from '@/lib/ai/provider';

const MATCH_REPLY = z.object({ ranking: z.array(z.object({ label: z.string(), reason: z.string() })) });

export interface MatchCandidate {
  label: string; // 'A', 'B', ...
  skills: string[];
  interests?: string | null;
  activeMentees: number;
  capacity?: number | null;
}

export interface MatchMentee {
  skills: string[];
  targetPosition?: string | null;
  interests?: string | null;
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ranking: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['label', 'reason'],
      },
    },
  },
  required: ['ranking'],
} as const;

const SYSTEM = `You rank anonymous mentor candidates for a mentee. Consider skill overlap AND adjacency (e.g. React↔frontend), the mentee's target position, shared interests, and mentor load (prefer mentors under capacity). Return the top 3 labels, best first, each with ONE short sentence of reasoning in the same language as the input data. Only use the provided labels.`;

export async function aiRankMentors(
  mentee: MatchMentee,
  candidates: MatchCandidate[]
): Promise<{ label: string; reason: string }[]> {
  const payload = {
    mentee: { skills: mentee.skills, targetPosition: mentee.targetPosition ?? '', interests: mentee.interests ?? '' },
    mentors: candidates.map((c) => ({
      label: c.label,
      skills: c.skills,
      interests: c.interests ?? '',
      activeMentees: c.activeMentees,
      capacity: c.capacity ?? null,
    })),
  };
  const reply = await callModel({ task: 'mentor_match', system: SYSTEM, input: JSON.stringify(payload), jsonSchema: SCHEMA });
  // Not the JSON asked for → no AI ranking (the rule-based order stands), and
  // the call is recorded as parse_error (#2024).
  const parsed = safeParseModelJson(reply, MATCH_REPLY, { ranking: [] });
  return parsed.ranking;
}
