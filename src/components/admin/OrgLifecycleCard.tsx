'use client';

import { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

// Tenant lifecycle (#1580, docs/tenant-lifecycle.md): rename / re-slug and
// archive / unarchive one organization. Super admin only — the page mounts it
// for a super admin, and the routes refuse everybody else regardless.

export interface LifecycleOrgRow {
  id: string;
  name: string;
  slug: string;
  ssoEnabled: boolean;
  archivedAt: string | null;
}

export function OrgLifecycleCard({ orgs, onChanged }: { orgs: LifecycleOrgRow[]; onChanged: () => Promise<void> | void }) {
  const t = useT();
  const L = t.orgLifecycle;
  const [orgId, setOrgId] = useState('');
  const org = orgs.find((o) => o.id === orgId) ?? null;
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setName(org?.name ?? '');
    setSlug(org?.slug ?? '');
    setForce(false);
  }, [org?.id, org?.name, org?.slug]);

  const slugChanging = !!org && slug.trim() !== '' && slug.trim() !== org.slug;

  const rename = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!org) return;
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(`/api/admin/organizations/${org.id}/rename`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, slug, ...(force ? { force: true } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setMsg({ ok: true, text: L.renamed });
        await onChanged();
      } else {
        const known: Record<string, string> = {
          slug_taken: L.errSlugTaken,
          sso_slug_locked: L.errSsoSlug,
          default_org_slug: L.errDefaultSlug,
          nothing_to_change: L.errNothing,
          archived: L.errArchived,
        };
        setMsg({ ok: false, text: known[data.code] ?? data.error ?? t.common.error });
      }
    } finally {
      setBusy(false);
    }
  };

  const toggleArchive = async () => {
    if (!org) return;
    const archive = !org.archivedAt;
    if (!window.confirm((archive ? L.archiveConfirm : L.unarchiveConfirm).replace('{org}', org.name))) return;
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(`/api/admin/organizations/${org.id}/archive`, { method: archive ? 'POST' : 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setMsg({ ok: true, text: archive ? L.archivedDone : L.unarchivedDone });
        await onChanged();
      } else {
        const known: Record<string, string> = { default_org: L.errDefaultArchive, own_org: L.errOwnArchive };
        setMsg({ ok: false, text: known[data.code] ?? data.error ?? t.common.error });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mb-6 max-w-2xl" data-testid="org-lifecycle-card">
      <CardHeader><CardTitle>{L.title}</CardTitle></CardHeader>
      <p className="text-sm text-gray-500 mb-3">{L.hint}</p>
      <div className="mb-3">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5" htmlFor="org-lifecycle-select">
          {L.select}
        </label>
        <select
          id="org-lifecycle-select"
          data-testid="org-lifecycle-select"
          value={orgId}
          onChange={(e) => { setOrgId(e.target.value); setMsg(null); }}
          className="block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm"
        >
          <option value="">—</option>
          {orgs.map((o) => (
            <option key={o.id} value={o.id}>{o.archivedAt ? `${o.name} (${L.archivedBadge})` : o.name}</option>
          ))}
        </select>
      </div>

      {org && (
        <div className="space-y-4">
          <form onSubmit={rename} className="space-y-3">
            <div className="flex flex-wrap gap-3">
              <div className="flex-1 min-w-[180px]">
                <Input label={L.name} value={name} disabled={!!org.archivedAt} onChange={(e) => setName(e.target.value)} data-testid="org-lifecycle-name" />
              </div>
              <div className="flex-1 min-w-[160px]">
                <Input label={L.slug} value={slug} disabled={!!org.archivedAt} onChange={(e) => setSlug(e.target.value)} data-testid="org-lifecycle-slug" />
              </div>
            </div>
            {slugChanging && org.ssoEnabled && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
                <p>{L.ssoSlugWarning}</p>
                <label className="mt-2 flex items-center gap-2">
                  <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} data-testid="org-lifecycle-force" />
                  {L.ssoSlugForce}
                </label>
              </div>
            )}
            <Button type="submit" loading={busy} disabled={!!org.archivedAt} data-testid="org-lifecycle-rename">{L.renameSave}</Button>
          </form>

          <div className="border-t border-gray-100 pt-4 dark:border-gray-800">
            <p className="text-sm text-gray-500 mb-2">{org.archivedAt ? L.archivedState : L.archiveHint}</p>
            <Button
              type="button"
              variant={org.archivedAt ? 'outline' : 'danger'}
              loading={busy}
              onClick={toggleArchive}
              data-testid="org-lifecycle-archive"
            >
              {org.archivedAt ? L.unarchive : L.archive}
            </Button>
          </div>
        </div>
      )}
      {msg && (
        <p role="status" className={`text-sm mt-3 ${msg.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600'}`} data-testid="org-lifecycle-msg">
          {msg.text}
        </p>
      )}
    </Card>
  );
}
