import type { ResolvedStage } from './pipeline';

export interface EligibilityRelation {
  status: string;
  pipelineStatus: string;
}

// Whether a mentorship relation has progressed far enough to issue an
// internship completion certificate (#813). Two independent signals, because a
// tenant may have fully replaced the default pipeline stages (#747) and
// dropped the canonical INTERNSHIP_COMPLETED_490 key entirely:
//  1. The relation itself is marked COMPLETED — works for any pipeline.
//  2. The current stage is at-or-past the canonical "internship completed"
//     stage, when that key still exists in the resolved (possibly custom) set.
// If neither signal is available (custom pipeline without that key, relation
// still ACTIVE), the certificate action stays hidden rather than guessing.
export function canIssueCertificate(relation: EligibilityRelation, stages: ResolvedStage[]): boolean {
  if (relation.status === 'COMPLETED') return true;
  const completedStage = stages.find((s) => s.key === 'INTERNSHIP_COMPLETED_490');
  const currentStage = stages.find((s) => s.key === relation.pipelineStatus);
  if (!completedStage || !currentStage) return false;
  return currentStage.order >= completedStage.order;
}
