'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';

// The ADMIN's editor for `Company.externalId` (#2560) on /admin/companies/[id].
// A partial PUT: it sends `externalId` and nothing else, and the route writes
// only the keys a body names. The labels come from the server page, which has
// already applied the tenant's vertical overlay.

export interface CompanyExternalIdLabels {
  label: string;
  hint: string;
  save: string;
  saved: string;
  /** "{name}" is the account that already holds the id. */
  taken: string;
  failed: string;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'saved' }
  | { kind: 'taken'; conflict: { id: string; name: string } }
  | { kind: 'failed' };

export function CompanyExternalIdForm({
  companyId,
  initial,
  labels,
}: {
  companyId: string;
  initial: string | null;
  labels: CompanyExternalIdLabels;
}) {
  const router = useRouter();
  const [value, setValue] = useState(initial ?? '');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setStatus({ kind: 'idle' });
    const normalized = value.trim();
    try {
      const res = await fetch(`/api/companies/${companyId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ externalId: normalized || null }),
      });
      if (res.ok) {
        // Show what was stored (the route trims), and re-render the server
        // page so its header badge follows the new id instead of the old one.
        setValue(normalized);
        setStatus({ kind: 'saved' });
        router.refresh();
        return;
      }
      const body = await res.json().catch(() => ({}));
      if (res.status === 409 && body?.code === 'external_id_taken' && body.conflict) {
        setStatus({ kind: 'taken', conflict: body.conflict });
        return;
      }
      setStatus({ kind: 'failed' });
    } catch {
      setStatus({ kind: 'failed' });
    } finally {
      setSaving(false);
    }
  };

  const [takenBefore, takenAfter] = labels.taken.split('{name}');

  return (
    <form onSubmit={save} className="space-y-2" data-testid="company-external-id-form">
      <label htmlFor="company-external-id" className="block text-sm font-medium text-gray-700">
        {labels.label}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id="company-external-id"
          data-testid="company-external-id-input"
          type="text"
          maxLength={191}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-describedby="company-external-id-hint"
          className="min-w-[12rem] flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono"
        />
        <Button type="submit" size="sm" loading={saving} data-testid="company-external-id-save">
          {labels.save}
        </Button>
      </div>
      <p id="company-external-id-hint" className="text-xs text-gray-500">
        {labels.hint}
      </p>
      <div aria-live="polite">
        {status.kind === 'saved' && (
          <p className="text-sm text-green-700 dark:!text-green-300" data-testid="company-external-id-saved">
            {labels.saved}
          </p>
        )}
        {status.kind === 'taken' && (
          <p className="text-sm text-amber-800 dark:!text-amber-300" role="alert" data-testid="company-external-id-taken">
            {takenBefore}
            <Link href={`/admin/companies/${status.conflict.id}`} className="font-medium underline">
              {status.conflict.name}
            </Link>
            {takenAfter}
          </p>
        )}
        {status.kind === 'failed' && (
          <p className="text-sm text-red-700 dark:!text-red-300" role="alert" data-testid="company-external-id-failed">
            {labels.failed}
          </p>
        )}
      </div>
    </form>
  );
}
