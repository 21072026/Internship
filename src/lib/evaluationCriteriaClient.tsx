'use client';

import { createContext, useContext } from 'react';
import {
  criterionLabel,
  defaultCriteria,
  type EvaluationScope,
  type ResolvedCriterion,
} from '@/lib/evaluation';
import { useT, useLocale } from '@/i18n/client';

// Client access to the viewer's tenant evaluation criteria (#822), the same
// shape PipelineStagesProvider has for #747's stages. The server layout resolves
// the org's CUSTOM criteria (or null when it uses the built-ins) and provides
// them here. When null, the built-ins are used and their labels come from the
// dictionary in the *viewer's* language — a custom framework renders in the
// language its author wrote it in, falling back to English, then to the key.

type CriteriaByScope = Record<EvaluationScope, ResolvedCriterion[]>;

const Ctx = createContext<CriteriaByScope | null>(null);

export function EvaluationCriteriaProvider({
  criteria,
  children,
}: {
  criteria: CriteriaByScope | null;
  children: React.ReactNode;
}) {
  return <Ctx.Provider value={criteria}>{children}</Ctx.Provider>;
}

/** The viewer's criteria for a scope (custom if set, else the built-ins). */
export function useCriteria(scope: EvaluationScope): ResolvedCriterion[] {
  const ctx = useContext(Ctx);
  const custom = ctx?.[scope];
  return custom && custom.length > 0 ? custom : defaultCriteria(scope);
}

/** A label(criterion) resolver bound to the viewer's locale + dictionary. */
export function useCriterionLabel(): (criterion: ResolvedCriterion) => string {
  const t = useT();
  const locale = useLocale();
  const builtIn = t.evaluation.criteria as Record<string, string>;
  return (criterion: ResolvedCriterion) => criterionLabel(criterion, locale, builtIn);
}

export { type ResolvedCriterion };
