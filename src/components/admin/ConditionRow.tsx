'use client';

// One condition row of an admin rule builder: allowlisted field → operator →
// typed value (#1686). Shared on purpose — the nudge segment builder and the
// stage-automation builder (#1704) describe their conditions the same way, so
// they use one row rather than two that drift. The row knows nothing about a
// vocabulary: the caller passes the allowlist (fields, the operators each
// takes, the kind of value), and the server re-validates whatever is sent.
import { X } from 'lucide-react';

export interface ConditionOption {
  value: string;
  label: string;
}

export interface ConditionFieldDef {
  value: string;
  label: string;
  ops: ConditionOption[];
  /** select = one of `options`; multi = several of `options`; number = whole days; boolean = yes/no. */
  input: 'select' | 'multi' | 'number' | 'boolean';
  options?: ConditionOption[];
}

export interface ConditionValue {
  field: string;
  op: string;
  value: unknown;
}

const control =
  'rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100';

/** A fresh value for a field, so switching the field never carries a value of the wrong type. */
export function defaultConditionValue(def: ConditionFieldDef): unknown {
  if (def.input === 'number') return 0;
  if (def.input === 'boolean') return true;
  if (def.input === 'multi') return def.options?.[0] ? [def.options[0].value] : [];
  return def.options?.[0]?.value ?? '';
}

export function ConditionRow({
  fields,
  condition,
  onChange,
  onRemove,
  labels,
  testId,
}: {
  fields: ConditionFieldDef[];
  condition: ConditionValue;
  onChange: (next: ConditionValue) => void;
  onRemove: () => void;
  labels: { field: string; op: string; value: string; remove: string; yes: string; no: string };
  testId?: string;
}) {
  const def = fields.find((f) => f.value === condition.field) ?? fields[0];
  const setField = (field: string) => {
    const next = fields.find((f) => f.value === field) ?? fields[0];
    onChange({ field: next.value, op: next.ops[0]?.value ?? '', value: defaultConditionValue(next) });
  };

  let valueControl: React.ReactNode = null;
  if (def.input === 'number') {
    valueControl = (
      <input
        type="number" min={0} max={3650} step={1} aria-label={labels.value} className={`${control} w-24`}
        value={typeof condition.value === 'number' ? condition.value : 0}
        onChange={(e) => onChange({ ...condition, value: Math.max(0, Math.trunc(Number(e.target.value) || 0)) })}
      />
    );
  } else if (def.input === 'boolean') {
    valueControl = (
      <select aria-label={labels.value} className={control} value={condition.value === false ? 'false' : 'true'}
        onChange={(e) => onChange({ ...condition, value: e.target.value === 'true' })}>
        <option value="true">{labels.yes}</option>
        <option value="false">{labels.no}</option>
      </select>
    );
  } else if (def.input === 'multi') {
    const selected = Array.isArray(condition.value) ? (condition.value as string[]) : [];
    valueControl = (
      <select multiple aria-label={labels.value} className={`${control} min-w-[12rem]`} size={Math.min(5, def.options?.length ?? 1)}
        value={selected}
        onChange={(e) => onChange({ ...condition, value: Array.from(e.target.selectedOptions).map((o) => o.value) })}>
        {def.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  } else {
    valueControl = (
      <select aria-label={labels.value} className={control} value={String(condition.value ?? '')}
        onChange={(e) => onChange({ ...condition, value: e.target.value })}>
        {def.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }

  return (
    <div className="flex flex-wrap items-start gap-2" data-testid={testId}>
      <select aria-label={labels.field} className={control} value={def.value} onChange={(e) => setField(e.target.value)}>
        {fields.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
      </select>
      <select aria-label={labels.op} className={control} value={condition.op} onChange={(e) => onChange({ ...condition, op: e.target.value })}>
        {def.ops.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {valueControl}
      <button type="button" onClick={onRemove} aria-label={labels.remove} title={labels.remove} className="p-1.5 text-gray-400 hover:text-red-600">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
