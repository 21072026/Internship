'use client';

import { useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { useT } from '@/i18n/client';
import { FREE_MONTHS_RANGE, PASSIVE_AFTER_DAYS_RANGE, type CustomerStatusSettings as Values } from '@/lib/affiliateCustomerStatusRule';

// The customer-status thresholds (#3542): the free period after registration and
// the days without a payment before a paying customer counts as passive. Not part
// of the commission plan. The server is the judge (parseCustomerStatusSettings);
// this form sends what is typed and marks the fields the server names.

function wholeNumber(text: string): number {
  return /^\d+$/.test(text.trim()) ? Number(text.trim()) : NaN;
}

export function CustomerStatusSettings({ initial, readOnly }: { initial: Values; readOnly: boolean }) {
  const t = useT();
  const L = t.affiliateSettings;
  const toast = useToast();
  const [freeMonths, setFreeMonths] = useState(String(initial.freeMonths));
  const [passiveAfterDays, setPassiveAfterDays] = useState(String(initial.passiveAfterDays));
  const [issues, setIssues] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const err = (field: keyof Values) => (issues.has(field) ? L.errorInvalid : undefined);

  async function save() {
    setBusy(true);
    setIssues(new Set());
    try {
      const res = await fetch('/api/admin/affiliate/settings/customer-status', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ freeMonths: wholeNumber(freeMonths), passiveAfterDays: wholeNumber(passiveAfterDays) }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        toast(body.changed ? L.customerStatusSaved : L.customerStatusUnchanged);
      } else if (body.code === 'invalid_settings') {
        setIssues(new Set((body.issues ?? []).map((i: { field: string }) => i.field)));
        toast(L.errorInvalid, 'error');
      } else toast(body.code === 'conflict' ? L.errorConflict : L.loadFailed, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{L.customerStatusTitle}</CardTitle>
        <p className="text-sm text-gray-600 dark:text-gray-400">{L.customerStatusHint}</p>
      </CardHeader>
      <fieldset disabled={readOnly} className="space-y-3">
        <Input
          label={L.freeMonths}
          hint={L.freeMonthsHint}
          type="number"
          inputMode="numeric"
          min={FREE_MONTHS_RANGE.min}
          max={FREE_MONTHS_RANGE.max}
          value={freeMonths}
          error={err('freeMonths')}
          onChange={(e) => setFreeMonths(e.target.value)}
          data-testid="affiliate-free-months"
        />
        <Input
          label={L.passiveAfterDays}
          hint={L.passiveAfterDaysHint}
          type="number"
          inputMode="numeric"
          min={PASSIVE_AFTER_DAYS_RANGE.min}
          max={PASSIVE_AFTER_DAYS_RANGE.max}
          value={passiveAfterDays}
          error={err('passiveAfterDays')}
          onChange={(e) => setPassiveAfterDays(e.target.value)}
          data-testid="affiliate-passive-after-days"
        />
        {!readOnly && (
          <Button type="button" onClick={() => void save()} disabled={busy} data-testid="affiliate-save-customer-status">
            {L.saveCustomerStatus}
          </Button>
        )}
      </fieldset>
    </Card>
  );
}
