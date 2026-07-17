'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useT } from '@/i18n/client';
import type { OrgPlan, OrgPlanLimits } from '@/lib/orgPlans';

interface Organization {
  id: string;
  name: string;
  slug: string;
  plan: OrgPlan;
  limits: OrgPlanLimits;
  createdAt: string;
  counts: {
    users: number;
    sources: number;
    cohorts: number;
    companies: number;
    projects: number;
    relations: number;
  };
}

// Render "used / limit" and flag over-limit in red (advisory only).
function Usage({ used, limit }: { used: number; limit: number | null }) {
  const over = limit != null && used > limit;
  return (
    <span className={over ? 'text-red-600 font-medium' : ''}>
      {used}{limit != null ? ` / ${limit}` : ' / ∞'}
    </span>
  );
}

export default function AdminOrganizationsPage() {
  const t = useT();
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [plans, setPlans] = useState<OrgPlan[]>([]);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/organizations');
    if (res.ok) {
      const data = await res.json();
      setOrgs(data.organizations ?? []);
      setPlans(data.plans ?? []);
    }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/organizations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, slug }),
      });
      if (res.ok) { setName(''); setSlug(''); await load(); }
      else setError((await res.json().catch(() => ({}))).error ?? t.common.error);
    } finally {
      setSaving(false);
    }
  };

  const changePlan = async (id: string, plan: string) => {
    setSaving(true);
    try {
      const res = await fetch('/api/admin/organizations', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, plan }),
      });
      if (res.ok) await load();
    } finally {
      setSaving(false);
    }
  };

  const q = search.trim().toLowerCase();
  const filtered = orgs.filter((o) => !q || o.name.toLowerCase().includes(q) || o.slug.toLowerCase().includes(q));

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.organizations.title}</h1>
        <p className="text-gray-500 mt-1">{t.organizations.subtitle}</p>
      </div>

      <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
        {t.organizations.phaseNote}
      </div>

      <Card className="mb-6 max-w-2xl">
        <CardHeader><CardTitle>{t.organizations.newOrg}</CardTitle></CardHeader>
        <form onSubmit={create} className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[180px]">
            <Input label={t.organizations.name} value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="flex-1 min-w-[160px]">
            <Input label={t.organizations.slug} value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="acme-inc" />
          </div>
          <Button type="submit" loading={saving}>{t.organizations.create}</Button>
        </form>
        <p className="text-xs text-gray-500 mt-2">{t.organizations.slugHint}</p>
        {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
      </Card>

      {!loading && orgs.length > 0 && (
        <div className="flex items-center mb-4">
          <input
            type="search"
            data-testid="org-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t.organizations.searchPlaceholder}
            className="w-full sm:w-64 rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
          />
        </div>
      )}

      <Card>
        <CardHeader><CardTitle>{t.organizations.title} ({filtered.length})</CardTitle></CardHeader>
        {loading ? (
          <SkeletonRows rows={5} />
        ) : orgs.length === 0 ? (
          <p className="text-center py-10 text-gray-400">{t.organizations.none}</p>
        ) : filtered.length === 0 ? (
          <p className="text-center py-10 text-gray-400">{t.organizations.none}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-100">
                  <th className="py-2 pr-4">{t.organizations.name}</th>
                  <th className="py-2 pr-4">{t.organizations.slug}</th>
                  <th className="py-2 pr-4">{t.organizations.plan}</th>
                  <th className="py-2 pr-4">{t.organizations.users}</th>
                  <th className="py-2 pr-4">{t.organizations.relations}</th>
                  <th className="py-2 pr-4">{t.organizations.projects}</th>
                  <th className="py-2 pr-4">{t.organizations.companies}</th>
                  <th className="py-2 pr-4">{t.organizations.cohorts}</th>
                  <th className="py-2 pr-4">{t.organizations.sources}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((o) => (
                  <tr key={o.id} data-testid={`org-row-${o.id}`} className="border-b border-gray-50">
                    <td className="py-2 pr-4 font-medium text-gray-900 dark:text-gray-100">{o.name}</td>
                    <td className="py-2 pr-4 text-gray-500"><code className="text-xs">{o.slug}</code></td>
                    <td className="py-2 pr-4">
                      <select
                        aria-label={t.organizations.plan}
                        data-testid={`org-plan-${o.id}`}
                        value={o.plan}
                        disabled={saving}
                        onChange={(e) => changePlan(o.id, e.target.value)}
                        className="rounded-lg border border-gray-300 px-2 py-1 text-xs"
                      >
                        {plans.map((p) => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </td>
                    <td className="py-2 pr-4"><Usage used={o.counts.users} limit={o.limits.maxUsers} /></td>
                    <td className="py-2 pr-4"><Usage used={o.counts.relations} limit={o.limits.maxActiveRelations} /></td>
                    <td className="py-2 pr-4"><Usage used={o.counts.projects} limit={o.limits.maxProjects} /></td>
                    <td className="py-2 pr-4">{o.counts.companies}</td>
                    <td className="py-2 pr-4">{o.counts.cohorts}</td>
                    <td className="py-2 pr-4">{o.counts.sources}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
