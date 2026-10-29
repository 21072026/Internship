'use client';

import type { ReactNode } from 'react';
import { X } from 'lucide-react';

// One allowlisted condition row: field → operator → value (#1704). Shared on
// purpose: the stage-automation builder (/admin/automations) is its first user,
// and the audience-nudge builder (#1686) imports it rather than shipping a
// second one. The row knows nothing about either engine — the caller passes the
// allowlisted fields, the operators each field accepts and a value editor, and
// the server's write-time gate stays the authority on what may be stored.

export interface ConditionFieldOption {
  value: string;
  label: string;
  ops: readonly { value: string; label: string }[];
}

export function ConditionRow({
  fields,
  field,
  op,
  onFieldChange,
  onOpChange,
  valueEditor,
  onRemove,
  removeLabel,
  testId,
}: {
  fields: readonly ConditionFieldOption[];
  field: string;
  op: string;
  onFieldChange: (field: string) => void;
  onOpChange: (op: string) => void;
  /** The value control for the current field (a select, a number, a multi-select…). */
  valueEditor: ReactNode;
  onRemove: () => void;
  removeLabel: string;
  testId?: string;
}) {
  const current = fields.find((f) => f.value === field) ?? fields[0];
  const select = 'rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1.5 text-sm';
  return (
    <div className="flex flex-wrap items-start gap-2" data-testid={testId}>
      <select aria-label={current?.label} className={select} value={field} onChange={(e) => onFieldChange(e.target.value)}>
        {fields.map((f) => (
          <option key={f.value} value={f.value}>{f.label}</option>
        ))}
      </select>
      <select aria-label={current?.label} className={select} value={op} onChange={(e) => onOpChange(e.target.value)}>
        {(current?.ops ?? []).map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <div className="min-w-[10rem] flex-1">{valueEditor}</div>
      <button type="button" onClick={onRemove} className="rounded p-1.5 text-gray-500 hover:text-red-600" aria-label={removeLabel} title={removeLabel}>
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
