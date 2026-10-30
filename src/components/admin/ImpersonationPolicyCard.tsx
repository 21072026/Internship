'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { useT } from '@/i18n/client';

// An organization's impersonation policy (#1586) on /admin/organizations.
// Reads and writes /api/admin/organizations/[id]/impersonation-policy; the
// enforcement is server-side (the start route and one middleware refusal),
// this card only sets the value.

const POLICIES = ['full', 'read_only', 'off'] as const;

export function ImpersonationPolicyCard({ orgs }: { orgs: { id: string; name: string }[] }) {
  const t = useT();
  const o = t.organizations;
  const [orgId, setOrgId] = useState(orgs[0]?.id ?? '');
  const [policy, setPolicy] = useState<string>('full');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const api = `/api/admin/organizations/${encodeURIComponent(orgId)}/impersonation-policy`;

  const load = useCallback(async () => {
    if (!orgId) return;
    const res = await fetch(api);
    if (res.ok) setPolicy((await res.json()).policy);
  }, [api, orgId]);
  useEffect(() => {
    setMsg('');
    load();
  }, [load]);

  const save = async (next: string) => {
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch(api, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ policy: next }) });
      if (res.ok) {
        setPolicy(next);
        setMsg(o.impersonationSaved);
      } else setMsg(o.impersonationSaveFailed);
    } finally {
      setBusy(false);
    }
  };

  const label = (p: string) => (p === 'full' ? o.impersonationFull : p === 'read_only' ? o.impersonationReadOnly : o.impersonationOff);
  const hint = (p: string) => (p === 'full' ? o.impersonationFullHint : p === 'read_only' ? o.impersonationReadOnlyHint : o.impersonationOffHint);

  return (
    <Card className="mb-6 max-w-2xl" data-testid="impersonation-policy-card">
      <CardHeader><CardTitle>{o.impersonationTitle}</CardTitle></CardHeader>
      <p className="mb-3 text-sm text-gray-500">{o.impersonationHint}</p>
      {orgs.length > 1 && (
        <label className="mb-3 flex flex-col text-sm text-gray-700 dark:text-gray-300">
          {o.title}
          <select data-testid="impersonation-policy-org" className="mt-1 max-w-sm rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
            {orgs.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
      )}
      <div className="space-y-2 text-sm" role="radiogroup" aria-label={o.impersonationTitle}>
        {POLICIES.map((p) => (
          <label key={p} className="flex items-start gap-2">
            <input type="radio" name="impersonation-policy" data-testid={`impersonation-policy-${p}`} className="mt-1" checked={policy === p} disabled={busy} onChange={() => save(p)} />
            <span>
              {label(p)}
              <span className="block text-xs text-gray-500">{hint(p)}</span>
            </span>
          </label>
        ))}
      </div>
      {msg && <p className="mt-2 text-xs text-gray-600 dark:text-gray-300" role="status">{msg}</p>}
    </Card>
  );
}
