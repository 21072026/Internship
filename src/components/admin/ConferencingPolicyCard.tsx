'use client';

import { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';
import { CONFERENCING_POLICIES, type ConferencingPolicyKey } from '@/lib/conferencingRule';

// The tenant's conferencing policy (#2007), from /admin/organizations: pick
// an organization, see which video room its meetings get, change it. Reads
// and writes /api/admin/organizations/[id]/conferencing, so it carries its own
// state and needs nothing from the organizations list beyond id and name.

export function ConferencingPolicyCard({ orgs }: { orgs: { id: string; name: string }[] }) {
  const t = useT();
  const s = t.organizations;
  const [orgId, setOrgId] = useState('');
  const [policy, setPolicy] = useState<ConferencingPolicyKey | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    setPolicy(null);
    setMsg(null);
    setError(false);
    if (!orgId) return;
    let cancelled = false;
    fetch(`/api/admin/organizations/${encodeURIComponent(orgId)}/conferencing`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: { policy: ConferencingPolicyKey }) => {
        if (!cancelled) setPolicy(body.policy);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!orgId || !policy) return;
    setSaving(true);
    setMsg(null);
    setError(false);
    try {
      const res = await fetch(`/api/admin/organizations/${encodeURIComponent(orgId)}/conferencing`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policy }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setMsg(s.conferencingSaved);
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="mb-6 max-w-2xl" data-testid="conferencing-card">
      <CardHeader><CardTitle>{s.conferencing}</CardTitle></CardHeader>
      <p className="text-sm text-gray-500 mb-3">{s.conferencingHint}</p>
      <form onSubmit={save} className="space-y-3">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">{s.title}</label>
          <select
            value={orgId}
            data-testid="conferencing-org-select"
            onChange={(e) => setOrgId(e.target.value)}
            required
            className="block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm"
          >
            <option value="">—</option>
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </div>
        {orgId && policy && (
          <fieldset className="space-y-2">
            <legend className="sr-only">{s.conferencing}</legend>
            {CONFERENCING_POLICIES.map((key) => (
              <label
                key={key}
                className="flex items-start gap-3 rounded-lg border border-gray-200 dark:border-gray-700 p-3 text-sm cursor-pointer has-[:checked]:border-blue-400 has-[:checked]:bg-blue-50 dark:has-[:checked]:bg-blue-950/40"
              >
                <input
                  type="radio"
                  name="conferencing-policy"
                  value={key}
                  checked={policy === key}
                  onChange={() => setPolicy(key)}
                  data-testid={`conferencing-policy-${key}`}
                  className="mt-0.5"
                />
                <span>
                  <span className="block font-medium text-gray-900 dark:text-gray-100">{s.conferencingPolicy[key].label}</span>
                  <span className="block text-xs text-gray-500 dark:text-gray-400 mt-0.5">{s.conferencingPolicy[key].hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        {orgId && policy && (
          <Button type="submit" loading={saving} data-testid="conferencing-save">{t.common.save}</Button>
        )}
      </form>
      {msg && <p className="text-sm text-gray-600 mt-2" data-testid="conferencing-saved">{msg}</p>}
      {error && <p className="text-sm text-red-600 mt-2">{t.common.error}</p>}
    </Card>
  );
}
