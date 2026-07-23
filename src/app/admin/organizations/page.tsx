'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
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
  branding: {
    brandName: string | null;
    brandLogoUrl: string | null;
    brandColor: string | null;
    supportEmail: string | null;
  };
  sso: {
    ssoEnabled: boolean;
    ssoProvider: string | null;
    ssoIssuer: string | null;
    ssoEntryPoint: string | null;
    ssoCertificateSet: boolean;
    active: boolean;
  };
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

  // Branding editor (#546).
  const [brandOrgId, setBrandOrgId] = useState('');
  const [brandName, setBrandName] = useState('');
  const [brandLogoUrl, setBrandLogoUrl] = useState('');
  const [brandColor, setBrandColor] = useState('');
  const [brandSupport, setBrandSupport] = useState('');
  const [brandMsg, setBrandMsg] = useState<string | null>(null);

  const selectBrandOrg = (id: string) => {
    setBrandOrgId(id);
    setBrandMsg(null);
    const o = orgs.find((x) => x.id === id);
    setBrandName(o?.branding.brandName ?? '');
    setBrandLogoUrl(o?.branding.brandLogoUrl ?? '');
    setBrandColor(o?.branding.brandColor ?? '');
    setBrandSupport(o?.branding.supportEmail ?? '');
  };

  const saveBranding = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!brandOrgId) return;
    setSaving(true); setBrandMsg(null);
    try {
      const res = await fetch('/api/admin/organizations', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: brandOrgId, brandName, brandLogoUrl, brandColor, supportEmail: brandSupport }),
      });
      const data = await res.json().catch(() => ({}));
      setBrandMsg(res.ok ? t.organizations.brandingSaved : data.error || t.common.error);
      if (res.ok) await load();
    } finally {
      setSaving(false);
    }
  };

  // SSO config editor (#545).
  const [ssoOrgId, setSsoOrgId] = useState('');
  const [ssoEnabled, setSsoEnabled] = useState(false);
  const [ssoProvider, setSsoProvider] = useState('');
  const [ssoIssuer, setSsoIssuer] = useState('');
  const [ssoEntryPoint, setSsoEntryPoint] = useState('');
  const [ssoCertificate, setSsoCertificate] = useState('');
  const [ssoMsg, setSsoMsg] = useState<string | null>(null);

  const selectSsoOrg = (id: string) => {
    setSsoOrgId(id);
    setSsoMsg(null);
    const o = orgs.find((x) => x.id === id);
    setSsoEnabled(o?.sso.ssoEnabled ?? false);
    setSsoProvider(o?.sso.ssoProvider ?? '');
    setSsoIssuer(o?.sso.ssoIssuer ?? '');
    setSsoEntryPoint(o?.sso.ssoEntryPoint ?? '');
    setSsoCertificate(''); // never prefilled; leave blank to keep the stored cert
  };

  const saveSso = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ssoOrgId) return;
    setSaving(true); setSsoMsg(null);
    try {
      const body: Record<string, unknown> = {
        id: ssoOrgId, ssoEnabled, ssoProvider, ssoIssuer, ssoEntryPoint,
      };
      // Only send the cert when the admin actually typed one (blank = keep).
      if (ssoCertificate.trim()) body.ssoCertificate = ssoCertificate;
      const res = await fetch('/api/admin/organizations', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      setSsoMsg(res.ok ? t.organizations.ssoSaved : data.error || t.common.error);
      if (res.ok) { setSsoCertificate(''); await load(); }
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

      {orgs.length > 0 && (
        <Card className="mb-6 max-w-2xl">
          <CardHeader><CardTitle>{t.organizations.branding}</CardTitle></CardHeader>
          <p className="text-sm text-gray-500 mb-3">{t.organizations.brandingHint}</p>
          <form onSubmit={saveBranding} className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.organizations.title}</label>
              <select
                value={brandOrgId}
                data-testid="brand-org-select"
                onChange={(e) => selectBrandOrg(e.target.value)}
                required
                className="block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm"
              >
                <option value="">—</option>
                {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </div>
            {brandOrgId && (
              <div className="flex flex-wrap gap-3">
                <div className="flex-1 min-w-[160px]"><Input label={t.organizations.brandName} value={brandName} onChange={(e) => setBrandName(e.target.value)} placeholder="Internship CRM" /></div>
                <div className="flex-1 min-w-[160px]"><Input label={t.organizations.brandColor} value={brandColor} onChange={(e) => setBrandColor(e.target.value)} placeholder="#2563eb" /></div>
                <div className="flex-1 min-w-[220px]"><Input label={t.organizations.brandLogoUrl} value={brandLogoUrl} onChange={(e) => setBrandLogoUrl(e.target.value)} placeholder="https://…/logo.svg" /></div>
                <div className="flex-1 min-w-[200px]"><Input label={t.organizations.brandSupportEmail} type="email" value={brandSupport} onChange={(e) => setBrandSupport(e.target.value)} placeholder="help@acme.com" /></div>
              </div>
            )}
            {brandOrgId && <Button type="submit" loading={saving} data-testid="brand-save">{t.common.save}</Button>}
          </form>
          {brandMsg && <p className="text-sm text-gray-600 mt-2">{brandMsg}</p>}
        </Card>
      )}

      {orgs.length > 0 && (
        <Card className="mb-6 max-w-2xl">
          <CardHeader><CardTitle>{t.organizations.sso}</CardTitle></CardHeader>
          <p className="text-sm text-gray-500 mb-3">{t.organizations.ssoHint}</p>
          <form onSubmit={saveSso} className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.organizations.title}</label>
              <select
                value={ssoOrgId}
                data-testid="sso-org-select"
                onChange={(e) => selectSsoOrg(e.target.value)}
                required
                className="block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm"
              >
                <option value="">—</option>
                {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}{o.sso.active ? ' • SSO' : ''}</option>)}
              </select>
            </div>
            {ssoOrgId && (
              <>
                <div className="flex flex-wrap gap-3">
                  <div className="min-w-[140px]">
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.organizations.ssoProvider}</label>
                    <select value={ssoProvider} onChange={(e) => setSsoProvider(e.target.value)} className="block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm">
                      <option value="">—</option>
                      <option value="saml">SAML</option>
                      <option value="oidc">OIDC</option>
                    </select>
                  </div>
                  <div className="flex-1 min-w-[200px]"><Input label={t.organizations.ssoIssuer} value={ssoIssuer} onChange={(e) => setSsoIssuer(e.target.value)} placeholder="https://idp.example.com/metadata" /></div>
                  <div className="flex-1 min-w-[220px]"><Input label={t.organizations.ssoEntryPoint} value={ssoEntryPoint} onChange={(e) => setSsoEntryPoint(e.target.value)} placeholder="https://idp.example.com/sso" /></div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.organizations.ssoCertificate}</label>
                  <textarea
                    value={ssoCertificate}
                    onChange={(e) => setSsoCertificate(e.target.value)}
                    rows={3}
                    placeholder="-----BEGIN CERTIFICATE-----"
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-xs font-mono"
                  />
                  <p className="text-xs text-gray-400 mt-1">{t.organizations.ssoCertHint}</p>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" data-testid="sso-enabled" checked={ssoEnabled} onChange={(e) => setSsoEnabled(e.target.checked)} />
                  {t.organizations.ssoEnable}
                </label>
                <Button type="submit" loading={saving} data-testid="sso-save">{t.common.save}</Button>
              </>
            )}
          </form>
          {ssoMsg && <p className="text-sm text-gray-600 mt-2">{ssoMsg}</p>}
        </Card>
      )}

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
                  <th className="py-2 pr-4">{t.organizations.pipeline}</th>
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
                    <td className="py-2 pr-4">
                      <Link href={`/admin/organizations/${o.id}/pipeline`} className="text-blue-600 hover:underline text-xs">
                        {t.organizations.editPipeline}
                      </Link>
                    </td>
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
