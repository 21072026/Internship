// Deterministic heuristic for the "next action" hint on a mentorship relation.

export interface NextActionInput {
  pipelineStatus: string;
  lastInteractionAt?: Date | string | null;
}

// Localized labels for the next-action hint. `{d}` is replaced with the day
// count. Optional so server/tests can call without a dictionary (English default).
export interface NextActionLabels {
  logFirst: string;
  noContact: string;
  lastContact: string;
  pushHiring: string;
  onTrack: string;
}

const DEFAULT_LABELS: NextActionLabels = {
  logFirst: 'Log a first interaction',
  noContact: 'No contact in {d} days — reach out',
  lastContact: 'Last contact {d} days ago — follow up',
  pushHiring: 'Push toward hiring',
  onTrack: 'On track',
};

// Returns a short suggested next action + a severity level. Pass `labels`
// (e.g. `t.nextActions`) to localize; falls back to English.
export function nextAction(
  { pipelineStatus, lastInteractionAt }: NextActionInput,
  labels: NextActionLabels = DEFAULT_LABELS
): { text: string; level: 'ok' | 'warn' | 'urgent' } {
  const last = lastInteractionAt ? new Date(lastInteractionAt) : null;
  const days = last ? Math.floor((Date.now() - last.getTime()) / 86_400_000) : null;
  const withDays = (s: string) => s.replace('{d}', String(days));

  if (days === null) return { text: labels.logFirst, level: 'warn' };
  if (days >= 21) return { text: withDays(labels.noContact), level: 'urgent' };
  if (days >= 14) return { text: withDays(labels.lastContact), level: 'warn' };

  const ending = ['INTERNSHIP_COMPLETED_490', 'JOB_SEEKING_500', 'HIREABLE_600'];
  if (ending.includes(pipelineStatus)) return { text: labels.pushHiring, level: 'warn' };
  return { text: labels.onTrack, level: 'ok' };
}
