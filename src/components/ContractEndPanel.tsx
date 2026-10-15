'use client';

import { useEffect, useState } from 'react';
import { CalendarX } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { useToast } from '@/components/ui/Toast';
import { useT, useLocale } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';
import { daysUntilUtcDay } from '@/lib/trialReminderRule';
import { CONTRACT_STAGE_KEY, parseContractEndDate } from '@/lib/contractEndRule';

// A won customer's notice period (#2841, PATCH /api/mentorship/[id]/contract-end).
// Shown on a DEAL_WON record only. Setting the date is "the customer gave
// notice"; clearing it is "they withdrew it". The record stays won either way —
// a loss is a human's stage move.
export function ContractEndPanel({
  relationId,
  pipelineStatus,
  contractEndsAt,
  canEdit = true,
  onSaved,
}: {
  relationId: string;
  pipelineStatus: string;
  contractEndsAt: string | null | undefined;
  canEdit?: boolean;
  onSaved?: () => void | Promise<void>;
}) {
  const t = useT();
  const c = t.contractEnd;
  const locale = useLocale();
  const toast = useToast();
  const [date, setDate] = useState(contractEndsAt ? contractEndsAt.slice(0, 10) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => setDate(contractEndsAt ? contractEndsAt.slice(0, 10) : ''), [contractEndsAt]);

  if (pipelineStatus !== CONTRACT_STAGE_KEY) return null;

  const write = async (value: string | null) => {
    setError('');
    if (value !== null) {
      const parsed = parseContractEndDate(value);
      if (!parsed) return setError(c.invalidDate);
      if (daysUntilUtcDay(parsed, new Date()) < 0) return setError(c.inThePast);
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/mentorship/${relationId}/contract-end`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contractEndsAt: value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data?.code === 'in_the_past') return setError(c.inThePast);
        if (data?.code === 'conflict' || data?.code === 'not_won' || data?.code === 'relation_closed') {
          toast(c.conflict, 'error');
          await onSaved?.();
          return;
        }
        throw new Error();
      }
      toast(value === null ? c.cleared : c.saved);
      await onSaved?.();
    } catch {
      toast(c.saveError, 'error');
    } finally {
      setSaving(false);
    }
  };

  const days = contractEndsAt ? daysUntilUtcDay(new Date(contractEndsAt), new Date()) : null;
  return (
    <div
      className={`rounded-lg border p-3 ${contractEndsAt ? 'border-red-200 dark:border-red-800' : 'border-gray-200 dark:border-gray-700'}`}
      data-testid="contract-end-panel"
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <CalendarX className="h-4 w-4 text-gray-500 dark:text-gray-400" />
        <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">{c.title}</p>
        {contractEndsAt ? (
          <>
            <span className="text-sm text-gray-700 dark:text-gray-200" data-testid="contract-end-date">
              {formatDate(contractEndsAt, locale, { timeZone: 'UTC' })}
            </span>
            <Badge variant={days !== null && days <= 0 ? 'danger' : 'warning'} className="text-xs" data-testid="contract-end-status">
              {days !== null && days <= 0 ? c.endsToday : c.daysLeft.replace('{d}', String(days))}
            </Badge>
          </>
        ) : (
          <span className="text-xs text-gray-500 dark:text-gray-400">{c.none}</span>
        )}
      </div>
      <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">{c.hint}</p>
      {canEdit && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-48">
            <Input
              id={`contract-end-date-${relationId}`}
              type="date"
              label={c.date}
              value={date}
              disabled={saving}
              onChange={(e) => setDate(e.target.value)}
              data-testid="contract-end-input"
            />
          </div>
          <Button size="sm" loading={saving} disabled={!date} onClick={() => write(date)} data-testid="contract-end-save">
            {c.save}
          </Button>
          {contractEndsAt && (
            <Button size="sm" variant="outline" loading={saving} onClick={() => write(null)} data-testid="contract-end-clear">
              {c.clear}
            </Button>
          )}
        </div>
      )}
      {error && <p className="mt-2 text-xs text-red-700 dark:text-red-300" data-testid="contract-end-error">{error}</p>}
    </div>
  );
}
