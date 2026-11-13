'use client';

import { useRef, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { useLocale, useT } from '@/i18n/client';
import { formatDateTime } from '@/lib/relativeTime';
import { interpolate } from '@/lib/notificationText';
import { SETTINGS_TRANSFER_MAX_BYTES, type TransferSection } from '@/lib/affiliateSettingsTransferRule';

// Moving the programme's settings between environments (#3622, docs/affiliate-module.md
// § Moving the settings). Export is a download; import reads a file, asks the
// server for a preview (nothing written), lets the admin pick the sections — the
// plan never pre-selected and only with its own confirmation — and applies them.
// The server is the judge of every rule; this form only shows its answers.

type Status = 'changed' | 'same' | 'invalid';
interface Preview {
  section: TransferSection;
  status: Status;
  issues: string[];
  /** The value today and the file's, for the small settings only. */
  from?: unknown;
  to?: unknown;
}

export function SettingsTransfer({ readOnly }: { readOnly: boolean }) {
  const t = useT();
  const L = t.affiliateSettings;
  const locale = useLocale();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview[] | null>(null);
  const [exportedAt, setExportedAt] = useState<string>('');
  const [selected, setSelected] = useState<Set<TransferSection>>(new Set());
  const [confirmPlan, setConfirmPlan] = useState(false);
  const [busy, setBusy] = useState(false);

  const sectionLabel: Record<TransferSection, string> = {
    landing: L.transferSectionLanding,
    contract: L.transferSectionContract,
    customerStatus: L.transferSectionCustomerStatus,
    windowNotice: L.transferSectionWindowNotice,
    referralUrl: L.transferSectionReferralUrl,
    plan: L.transferSectionPlan,
  };
  // The small settings' values, so "will change" says from what to what.
  function valueText(section: TransferSection, v: unknown): string {
    if (v === null || v === undefined || v === '') return L.transferValueNone;
    if (section === 'customerStatus' && typeof v === 'object') {
      const c = v as { freeMonths: number; passiveAfterDays: number };
      return interpolate(L.transferCustomerStatusValue, { months: String(c.freeMonths), days: String(c.passiveAfterDays) });
    }
    if (section === 'windowNotice') return interpolate(L.transferDaysValue, { n: String(v) });
    return String(v);
  }

  const statusLabel: Record<Status, string> = { changed: L.transferStatusChanged, same: L.transferStatusSame, invalid: L.transferStatusInvalid };

  function clearPreview() {
    setFile(null);
    setPreview(null);
    setSelected(new Set());
    setConfirmPlan(false);
  }

  function reset() {
    clearPreview();
    if (input.current) input.current.value = '';
  }

  function refusal(code: unknown): string {
    if (code === 'too_large') return interpolate(L.transferTooLarge, { mb: String(SETTINGS_TRANSFER_MAX_BYTES / 1024 / 1024) });
    if (code === 'conflict' || code === 'asset_refused') return L.transferConflict;
    return L.transferFileInvalid;
  }

  async function choose(f: File | null) {
    // The picker keeps showing the chosen file; only the previous answer goes.
    clearPreview();
    if (!f) return;
    if (f.size > SETTINGS_TRANSFER_MAX_BYTES) {
      toast(refusal('too_large'), 'error');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/admin/affiliate/settings/import?dryRun=1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: f });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(refusal(body.code), 'error');
        return;
      }
      setFile(f);
      setPreview(body.preview as Preview[]);
      setExportedAt(typeof body.exportedAt === 'string' ? body.exportedAt : '');
      // The server's default (never the plan), minus what would not save or would change nothing.
      const usable = new Set((body.preview as Preview[]).filter((p) => p.status === 'changed').map((p) => p.section));
      setSelected(new Set((body.defaultSelection as TransferSection[]).filter((s) => usable.has(s))));
    } finally {
      setBusy(false);
    }
  }

  function toggle(section: TransferSection, on: boolean) {
    const next = new Set(selected);
    if (on) next.add(section);
    else next.delete(section);
    setSelected(next);
    if (section === 'plan' && !on) setConfirmPlan(false);
  }

  async function apply() {
    if (!file || selected.size === 0) return;
    setBusy(true);
    try {
      const qs = new URLSearchParams({ sections: [...selected].join(',') });
      if (selected.has('plan') && confirmPlan) qs.set('confirmPlan', '1');
      const res = await fetch(`/api/admin/affiliate/settings/import?${qs}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: file });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        toast(L.transferApplied);
        // Every card on the page holds its own copy of what it loaded; read them all again.
        window.location.reload();
        return;
      }
      if (body.code === 'invalid' && Array.isArray(body.preview)) setPreview(body.preview as Preview[]);
      toast(refusal(body.code), 'error');
    } finally {
      setBusy(false);
    }
  }

  const planBlocked = selected.has('plan') && !confirmPlan;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{L.transferTitle}</CardTitle>
        <p className="text-sm text-gray-600 dark:text-gray-400">{L.transferHint}</p>
      </CardHeader>
      <div className="space-y-4">
        <a
          href="/api/admin/affiliate/settings/export"
          download
          className="inline-flex items-center rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
          data-testid="affiliate-settings-export"
        >
          {L.transferExport}
        </a>

        {!readOnly && (
          <label className="block space-y-1">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{L.transferImportLabel}</span>
            <input
              ref={input}
              type="file"
              accept="application/json,.json"
              disabled={busy}
              onChange={(e) => void choose(e.target.files?.[0] ?? null)}
              className="block text-sm text-gray-700 dark:text-gray-300"
              data-testid="affiliate-settings-import-file"
            />
          </label>
        )}

        {preview && (
          <div className="space-y-3" data-testid="affiliate-settings-import-preview">
            {exportedAt && <p className="text-xs text-gray-500">{interpolate(L.transferExportedAt, { when: formatDateTime(exportedAt, locale) })}</p>}
            <ul className="divide-y divide-gray-200 rounded-md border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
              {preview.map((p) => (
                <li key={p.section} className="flex flex-wrap items-start gap-3 p-3" data-testid={`affiliate-import-row-${p.section}`}>
                  <input
                    type="checkbox"
                    className="mt-1"
                    aria-label={sectionLabel[p.section]}
                    checked={selected.has(p.section)}
                    disabled={busy || p.status !== 'changed'}
                    onChange={(e) => toggle(p.section, e.target.checked)}
                    data-testid={`affiliate-import-pick-${p.section}`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{sectionLabel[p.section]}</p>
                    <p className={`text-xs ${p.status === 'invalid' ? 'text-red-700 dark:text-red-400' : 'text-gray-600 dark:text-gray-400'}`}>
                      {statusLabel[p.status]}
                      {p.issues.length > 0 && <span className="ml-1 font-mono">({p.issues.join(', ')})</span>}
                    </p>
                    {p.status === 'changed' && 'to' in p && (
                      <p className="break-all text-xs text-gray-600 dark:text-gray-400" data-testid={`affiliate-import-values-${p.section}`}>
                        {valueText(p.section, p.from)} → {valueText(p.section, p.to)}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>

            {selected.has('contract') && (
              <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:text-amber-100" data-testid="affiliate-import-contract-warning">
                {L.transferContractWarning}
              </p>
            )}

            {selected.has('plan') && (
              <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:text-amber-100">
                <p>{L.transferPlanWarning}</p>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={confirmPlan}
                    onChange={(e) => setConfirmPlan(e.target.checked)}
                    data-testid="affiliate-import-confirm-plan"
                  />
                  <span>{L.transferPlanConfirm}</span>
                </label>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => void apply()} disabled={busy || selected.size === 0 || planBlocked} data-testid="affiliate-import-apply">
                {L.transferApply}
              </Button>
              <Button type="button" variant="secondary" onClick={reset} disabled={busy}>
                {L.transferCancel}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
