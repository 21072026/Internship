'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useT, useLocale } from '@/i18n/client';
import { attributeLabel } from '@/lib/orgAttributesRule';

// The tenant's SSO directory sync (#1943), inside the Enterprise SSO card next
// to the role mapping. Reads and writes
// /api/admin/organizations/[id]/sso-attribute-mappings; the rule that applies
// the rows is src/lib/ssoDirectorySyncRule.ts. The API lists back exactly the
// targets it accepts — the fixed profile fields, the photo, and this org's own
// attributes — so nothing else is offered here.

interface Mapping {
  id: string;
  claim: string;
  target: string;
}

interface Attr {
  key: string;
  labelEn: string;
  labelTr: string;
  labelDe: string;
}

interface SyncError {
  id: string;
  email: string;
  ssoSyncError: string;
  ssoLastSyncedAt: string | null;
}

export function SsoAttributeMappings({ orgId, locked }: { orgId: string; locked: boolean }) {
  const t = useT();
  const locale = useLocale();
  const o = t.organizations;
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [targets, setTargets] = useState<string[]>([]);
  const [attributes, setAttributes] = useState<Attr[]>([]);
  const [authoritative, setAuthoritative] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [errorCount, setErrorCount] = useState(0);
  const [syncErrors, setSyncErrors] = useState<SyncError[]>([]);
  const [claim, setClaim] = useState('');
  const [target, setTarget] = useState('department');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const base = `/api/admin/organizations/${encodeURIComponent(orgId)}/sso-attribute-mappings`;

  const fieldLabels: Record<string, string> = {
    fullName: o.ssoSyncFieldFullName,
    department: o.ssoSyncFieldDepartment,
    targetPosition: o.ssoSyncFieldTitle,
    city: o.ssoSyncFieldCity,
    country: o.ssoSyncFieldCountry,
    timezone: o.ssoSyncFieldTimezone,
    phone: o.ssoSyncFieldPhone,
    photo: o.ssoSyncFieldPhoto,
  };
  const targetLabel = (value: string) => {
    if (value.startsWith('attr:')) {
      const a = attributes.find((x) => `attr:${x.key}` === value);
      return a ? attributeLabel(a, locale) : value.slice(5);
    }
    return fieldLabels[value] ?? value;
  };

  const load = useCallback(async () => {
    const res = await fetch(base);
    if (!res.ok) return;
    const data = await res.json();
    setMappings(data.mappings ?? []);
    setTargets(data.targets ?? []);
    setAttributes(data.attributes ?? []);
    setAuthoritative(!!data.authoritative);
    setLastSyncedAt(data.lastSyncedAt ?? null);
    setErrorCount(data.accountsWithSyncErrors ?? 0);
    setSyncErrors(data.syncErrors ?? []);
  }, [base]);

  useEffect(() => {
    load();
  }, [load]);

  const options = [...targets, ...attributes.map((a) => `attr:${a.key}`)].filter((v) => !mappings.some((m) => m.target === v));
  const selected = options.includes(target) ? target : options[0] ?? '';

  const add = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claim, target: selected }),
      });
      if (res.status === 409) setError(o.ssoSyncDuplicate);
      else if (!res.ok) setError(o.ssoSyncSaveFailed);
      else {
        setClaim('');
        await load();
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await fetch(`${base}?mappingId=${encodeURIComponent(id)}`, { method: 'DELETE' });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const toggleAuthoritative = async (next: boolean) => {
    setBusy(true);
    try {
      const res = await fetch(base, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authoritative: next }),
      });
      if (res.ok) setAuthoritative(next);
    } finally {
      setBusy(false);
    }
  };

  const inputClass = 'rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';

  return (
    <div data-testid="sso-attribute-mappings" className="mt-4 space-y-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
      <div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{o.ssoSyncTitle}</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400">{o.ssoSyncHint}</p>
      </div>

      {mappings.length === 0 ? (
        <p className="text-sm text-gray-500" data-testid="sso-attribute-mappings-empty">{o.ssoSyncNone}</p>
      ) : (
        <table className="w-full text-sm" data-testid="sso-attribute-mappings-table">
          <thead>
            <tr className="text-left text-xs text-gray-500">
              <th className="py-1">{o.ssoRoleClaim}</th>
              <th className="py-1">{o.ssoSyncTarget}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {mappings.map((m) => (
              <tr key={m.id} data-testid={`sso-attribute-mapping-${m.target}`} className="border-t border-gray-100 dark:border-gray-800">
                <td className="py-1 break-all">{m.claim}</td>
                <td className="py-1">{targetLabel(m.target)}</td>
                <td className="py-1 text-right">
                  <Button type="button" size="sm" variant="outline" disabled={busy || locked} onClick={() => remove(m.id)}>
                    {o.ssoRoleRemove}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-xs text-gray-600 dark:text-gray-300">
          {o.ssoRoleClaim}
          <input data-testid="sso-attribute-claim" className={inputClass} value={claim} onChange={(e) => setClaim(e.target.value)} />
        </label>
        <label className="flex flex-col text-xs text-gray-600 dark:text-gray-300">
          {o.ssoSyncTarget}
          <select data-testid="sso-attribute-target" className={inputClass} value={selected} onChange={(e) => setTarget(e.target.value)}>
            {options.map((v) => (
              <option key={v} value={v}>{targetLabel(v)}</option>
            ))}
          </select>
        </label>
        <Button
          type="button"
          size="sm"
          data-testid="sso-attribute-add"
          loading={busy}
          disabled={locked || !claim.trim() || !selected}
          onClick={add}
        >
          {o.ssoRoleAdd}
        </Button>
      </div>
      {error && <p className="text-xs text-red-600" role="alert">{error}</p>}

      <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
        <input
          type="checkbox"
          data-testid="sso-attribute-authoritative"
          className="mt-1"
          disabled={busy || locked}
          checked={authoritative}
          onChange={(e) => toggleAuthoritative(e.target.checked)}
        />
        <span>
          {o.ssoSyncAuthoritative}
          <span className="block text-xs text-gray-500 dark:text-gray-400">{o.ssoSyncAuthoritativeHint}</span>
        </span>
      </label>

      <div className="text-xs text-gray-600 dark:text-gray-300" data-testid="sso-attribute-status">
        {lastSyncedAt ? (
          <p>
            {o.ssoSyncLast} <RelativeTime date={lastSyncedAt} />
          </p>
        ) : (
          <p>{o.ssoSyncNever}</p>
        )}
        {errorCount > 0 && (
          <div className="mt-1">
            <p className="font-medium text-amber-700 dark:text-amber-400">{o.ssoSyncErrors.replace('{count}', String(errorCount))}</p>
            <ul className="mt-1 space-y-0.5">
              {syncErrors.map((e) => (
                <li key={e.id} className="break-all" data-testid={`sso-attribute-error-${e.id}`}>
                  {e.email} — <code>{e.ssoSyncError}</code>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
