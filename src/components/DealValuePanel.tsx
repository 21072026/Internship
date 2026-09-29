'use client';

import { useEffect, useState } from 'react';
import { Coins } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';
import { useT, useLocale } from '@/i18n/client';
import { formatMinorAmount } from '@/lib/money';
import {
  DEAL_VALUE_CURRENCIES,
  DEFAULT_DEAL_VALUE_CURRENCY,
  dealValueInputText,
  parseDealValueInput,
  type DealValueInputError,
} from '@/lib/dealValue';

export interface DealValueState {
  valueMinor: number | null;
  currency: string | null;
  source: string | null;
}

/**
 * The ESTIMATED monthly value of one funnel record (#2422), with an editor for
 * its owner and ADMIN (GET/PUT /api/mentorship/[id]/value). Every word on it
 * says "estimated": pricing is usage-based, and this is a guess, not revenue.
 *
 * `initial` given → rendered straight away (the /sales page reads the row on the
 * server). `initial` omitted → the panel asks the route itself, and renders
 * nothing when the route says the record's vertical has no deal values (404) —
 * which is how the shared admin record page shows it for MARKETING only.
 */
export function DealValuePanel({
  relationId,
  initial,
  onSaved,
}: {
  relationId: string;
  initial?: DealValueState;
  onSaved?: () => void | Promise<void>;
}) {
  const t = useT();
  const d = t.dealValue;
  const locale = useLocale();
  const toast = useToast();
  const [state, setState] = useState<DealValueState | null>(initial ?? null);
  const [amount, setAmount] = useState(dealValueInputText(initial?.valueMinor));
  const [currency, setCurrency] = useState(initial?.currency ?? DEFAULT_DEAL_VALUE_CURRENCY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (initial) return;
    let cancelled = false;
    fetch(`/api/mentorship/${relationId}/value`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data?.value) return;
        setState(data.value);
        setAmount(dealValueInputText(data.value.valueMinor));
        setCurrency(data.value.currency ?? DEFAULT_DEAL_VALUE_CURRENCY);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [initial, relationId]);

  if (!state) return null;

  const message = (code: DealValueInputError | undefined) => (code ? d[code] : d.saveError);

  const save = async (next: string) => {
    setError('');
    const parsed = parseDealValueInput(next);
    if (!parsed.ok) {
      setError(message(parsed.error));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/mentorship/${relationId}/value`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ valueMinor: parsed.valueMinor, currency }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = data?.code as DealValueInputError | undefined;
        if (res.status === 400 && code && code in d) {
          setError(message(code));
          return;
        }
        throw new Error();
      }
      setState(data.value);
      setAmount(dealValueInputText(data.value?.valueMinor));
      toast(parsed.valueMinor === null ? d.cleared : d.saved);
      await onSaved?.();
    } catch {
      toast(d.saveError, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-700" data-testid="deal-value-panel">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <Coins className="h-4 w-4 text-gray-500 dark:text-gray-400" />
        <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">{d.title}</p>
        <span className="text-sm text-gray-700 dark:text-gray-200" data-testid="deal-value-current">
          {state.valueMinor != null && state.currency
            ? formatMinorAmount(state.valueMinor, state.currency, locale)
            : d.none}
        </span>
        {state.source === 'IMPORT' && <span className="text-xs text-gray-500 dark:text-gray-400">{d.fromImport}</span>}
      </div>
      <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">{d.hint}</p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-44">
          <Input
            id={`deal-value-amount-${relationId}`}
            label={d.amount}
            inputMode="decimal"
            placeholder="49,90"
            value={amount}
            disabled={saving}
            onChange={(e) => setAmount(e.target.value)}
            data-testid="deal-value-input"
          />
        </div>
        <div className="w-28">
          <Select
            id={`deal-value-currency-${relationId}`}
            label={d.currency}
            options={DEAL_VALUE_CURRENCIES.map((c) => ({ value: c, label: c }))}
            value={currency}
            disabled={saving}
            onChange={(e) => setCurrency(e.target.value)}
            data-testid="deal-value-currency"
          />
        </div>
        <Button size="sm" loading={saving} disabled={!amount.trim()} onClick={() => save(amount)} data-testid="deal-value-save">
          {d.save}
        </Button>
        {state.valueMinor != null && (
          <Button size="sm" variant="ghost" disabled={saving} onClick={() => save('')} data-testid="deal-value-clear">
            {d.clear}
          </Button>
        )}
      </div>
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400" data-testid="deal-value-error">{error}</p>}
    </div>
  );
}
