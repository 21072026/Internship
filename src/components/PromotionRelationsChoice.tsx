'use client';

import { useT } from '@/i18n/client';
import { useStageLabel } from '@/lib/pipelineStagesClient';
import { PROMOTION_CHOICES, type PromotionChoice } from '@/lib/promotionRelationsRule';

// The question a promotion to MENTOR asks when the person is still the mentee
// of open relations (#1506): which relations, and what happens to them.
// Shared by the role convert (RoleConvertButton) and the mentor application
// approval; the server refuses the promotion until a choice comes with it
// (src/lib/promotionRelationsRule.ts), so nothing here is the check.

export interface OpenRelationSummary {
  id: string;
  mentorName: string;
  pipelineStatus: string;
  kind: string;
}

export function PromotionRelationsChoice({
  relations,
  choice,
  onChoice,
  testIdPrefix = 'promotion',
}: {
  relations: readonly OpenRelationSummary[];
  choice: PromotionChoice | null;
  onChoice: (choice: PromotionChoice) => void;
  testIdPrefix?: string;
}) {
  const t = useT();
  const p = t.promotionRelations;
  const label = useStageLabel();
  return (
    <fieldset className="mt-3 rounded-md border border-gray-200 p-3 dark:border-gray-700" data-testid={`${testIdPrefix}-choice`}>
      <legend className="px-1 text-sm font-medium text-gray-900 dark:text-gray-100">{p.title}</legend>
      <p className="text-xs text-gray-600 dark:text-gray-300">{p.hint}</p>
      <ul className="mt-2 space-y-1 text-sm text-gray-700 dark:text-gray-300" data-testid={`${testIdPrefix}-relations`}>
        {relations.map((r) => (
          <li key={r.id}>
            {p.relationLine.replace('{mentor}', r.mentorName).replace('{stage}', r.kind === 'COACHING' ? p.coaching : label(r.pipelineStatus))}
          </li>
        ))}
      </ul>
      <div className="mt-3 space-y-1.5">
        {PROMOTION_CHOICES.map((value) => (
          <label key={value} className="flex items-start gap-2 text-sm text-gray-800 dark:text-gray-200">
            <input
              type="radio"
              name={`${testIdPrefix}-choice`}
              value={value}
              checked={choice === value}
              onChange={() => onChoice(value)}
              data-testid={`${testIdPrefix}-choice-${value}`}
              className="mt-0.5"
            />
            <span>{p.options[value]}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
