'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

// The tenant's IdP role mapping (#1940), inside the Enterprise SSO card. Reads
// and writes /api/admin/organizations/[id]/sso-role-mappings; the rule that
// applies the rows is src/lib/ssoRoleMapping.ts. ADMIN is not offered: the API
// only lists MAPPABLE_ROLES back.

interface Mapping {
  id: string;
  claim: string;
  matchValue: string;
  role: string;
  priority: number;
}

export function SsoRoleMappings({ orgId, locked }: { orgId: string; locked: boolean }) {
  const t = useT();
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [syncRole, setSyncRole] = useState(false);
  const [claim, setClaim] = useState('groups');
  const [matchValue, setMatchValue] = useState('');
  const [role, setRole] = useState('MENTOR');
  const [priority, setPriority] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const base = `/api/admin/organizations/${encodeURIComponent(orgId)}/sso-role-mappings`;

  const load = useCallback(async () => {
    const res = await fetch(base);
    if (!res.ok) return;
    const data = await res.json();
    setMappings(data.mappings ?? []);
    setRoles(data.roles ?? []);
    setSyncRole(!!data.syncRole);
  }, [base]);

  useEffect(() => {
    load();
  }, [load]);

  const add = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claim, matchValue, role, priority }),
      });
      if (res.status === 409) setError(t.organizations.ssoRoleDuplicate);
      else if (!res.ok) setError(t.organizations.ssoRoleSaveFailed);
      else {
        setMatchValue('');
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

  const toggleSync = async (next: boolean) => {
    setBusy(true);
    try {
      const res = await fetch(base, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ syncRole: next }),
      });
      if (res.ok) setSyncRole(next);
    } finally {
      setBusy(false);
    }
  };

  const inputClass = 'rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';

  return (
    <div data-testid="sso-role-mappings" className="mt-4 space-y-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
      <div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t.organizations.ssoRoleMappings}</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400">{t.organizations.ssoRoleMappingsHint}</p>
      </div>

      {mappings.length === 0 ? (
        <p className="text-sm text-gray-500" data-testid="sso-role-mappings-empty">{t.organizations.ssoRoleNone}</p>
      ) : (
        <table className="w-full text-sm" data-testid="sso-role-mappings-table">
          <thead>
            <tr className="text-left text-xs text-gray-500">
              <th className="py-1">{t.organizations.ssoRoleClaim}</th>
              <th className="py-1">{t.organizations.ssoRoleValue}</th>
              <th className="py-1">{t.organizations.ssoRoleRole}</th>
              <th className="py-1">{t.organizations.ssoRolePriority}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {mappings.map((m) => (
              <tr key={m.id} data-testid={`sso-role-mapping-${m.id}`} className="border-t border-gray-100 dark:border-gray-800">
                <td className="py-1 break-all">{m.claim}</td>
                <td className="py-1 break-all">{m.matchValue}</td>
                <td className="py-1 font-mono text-xs">{m.role}</td>
                <td className="py-1">{m.priority}</td>
                <td className="py-1 text-right">
                  <Button type="button" size="sm" variant="outline" disabled={busy || locked} onClick={() => remove(m.id)}>
                    {t.organizations.ssoRoleRemove}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-xs text-gray-600 dark:text-gray-300">
          {t.organizations.ssoRoleClaim}
          <input data-testid="sso-role-claim" className={inputClass} value={claim} onChange={(e) => setClaim(e.target.value)} />
        </label>
        <label className="flex flex-col text-xs text-gray-600 dark:text-gray-300">
          {t.organizations.ssoRoleValue}
          <input data-testid="sso-role-value" className={inputClass} value={matchValue} onChange={(e) => setMatchValue(e.target.value)} />
        </label>
        <label className="flex flex-col text-xs text-gray-600 dark:text-gray-300">
          {t.organizations.ssoRoleRole}
          <select data-testid="sso-role-role" className={inputClass} value={role} onChange={(e) => setRole(e.target.value)}>
            {roles.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-xs text-gray-600 dark:text-gray-300">
          {t.organizations.ssoRolePriority}
          <input
            data-testid="sso-role-priority"
            type="number"
            min={-100}
            max={100}
            className={`${inputClass} w-20`}
            value={priority}
            onChange={(e) => setPriority(Number(e.target.value) || 0)}
          />
        </label>
        <Button type="button" size="sm" data-testid="sso-role-add" loading={busy} disabled={locked || !claim.trim() || !matchValue.trim()} onClick={add}>
          {t.organizations.ssoRoleAdd}
        </Button>
      </div>
      {error && <p className="text-xs text-red-600" role="alert">{error}</p>}

      <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
        <input
          type="checkbox"
          data-testid="sso-role-sync"
          className="mt-1"
          disabled={busy || locked}
          checked={syncRole}
          onChange={(e) => toggleSync(e.target.checked)}
        />
        <span>
          {t.organizations.ssoRoleSync}
          <span className="block text-xs text-gray-500 dark:text-gray-400">{t.organizations.ssoRoleSyncHint}</span>
        </span>
      </label>
    </div>
  );
}
