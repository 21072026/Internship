'use client';

import { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useT, useLocale } from '@/i18n/client';

// Tenant lifecycle (#1580, docs/tenant-lifecycle.md): rename / re-slug,
// archive / unarchive and export one organization. Rename and archive are the
// super admin's; the export is also the tenant's own ORG_ADMIN's (#1584). The
// routes decide — this only hides what the account cannot use.

export interface LifecycleOrgRow {
  id: string;
  name: string;
  slug: string;
  ssoEnabled: boolean;
  archivedAt: string | null;
  deletionRequestedAt?: string | null;
  deletionEligibleAt?: string | null;
}

export function OrgLifecycleCard({
  orgs,
  onChanged,
  superAdmin,
  hardDelete = { enabled: false, waitHours: 72 },
}: {
  orgs: LifecycleOrgRow[];
  onChanged: () => Promise<void> | void;
  /** Permanent deletion (#1584): shown only when the deployment switched it on. */
  hardDelete?: { enabled: boolean; waitHours: number };
  /** A tenant ORG_ADMIN gets the export of its own org only (the route decides; this hides the rest). */
  superAdmin: boolean;
}) {
  const t = useT();
  const locale = useLocale();
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

  const [delSlug, setDelSlug] = useState('');
  const [delPassword, setDelPassword] = useState('');
  useEffect(() => { setDelSlug(''); setDelPassword(''); }, [org?.id]);

  const deletion = async (method: 'POST' | 'DELETE' | 'EXECUTE') => {
    if (!org) return;
    if (method === 'EXECUTE' && !window.confirm(L.deleteFinalConfirm.replace('{org}', org.name))) return;
    setBusy(true); setMsg(null);
    try {
      const res = method === 'EXECUTE'
        ? await fetch(`/api/admin/organizations/${org.id}`, {
            method: 'DELETE', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirmSlug: delSlug, password: delPassword }),
          })
        : await fetch(`/api/admin/organizations/${org.id}/deletion`, {
            method, headers: { 'Content-Type': 'application/json' },
            body: method === 'POST' ? JSON.stringify({ confirmSlug: delSlug }) : undefined,
          });
      const data = await res.json().catch(() => ({}));
      setDelPassword('');
      if (res.ok) {
        setMsg({ ok: true, text: method === 'POST' ? L.deleteRequestedDone : method === 'DELETE' ? L.deleteCancelledDone : L.deleteDone });
        if (method === 'EXECUTE') setOrgId('');
        await onChanged();
      } else {
        const known: Record<string, string> = {
          slug_mismatch: L.errDeleteSlug,
          waiting_period: L.errDeleteWaiting,
          export_required: L.errDeleteExport,
          password_incorrect: L.errDeletePassword,
          hard_delete_disabled: L.errDeleteDisabled,
        };
        setMsg({ ok: false, text: known[data.code] ?? data.error ?? t.common.error });
      }
    } finally {
      setBusy(false);
    }
  };

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
      <CardHeader><CardTitle>{superAdmin ? L.title : L.exportTitle}</CardTitle></CardHeader>
      <p className="text-sm text-gray-500 mb-3">{superAdmin ? L.hint : L.exportHint}</p>
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
        <div className="mb-4">
          {/* A plain download: the route streams the file with its own name. */}
          <a
            href={`/api/admin/organizations/${org.id}/export`}
            download
            data-testid="org-lifecycle-export"
            className="inline-flex items-center rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            {L.exportDownload}
          </a>
          <p className="mt-1 text-xs text-gray-500">{L.exportNote}</p>
        </div>
      )}

      {org && superAdmin && (
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

          {hardDelete.enabled && org.archivedAt && (
            <div className="border-t border-red-100 pt-4 dark:border-red-900" data-testid="org-lifecycle-delete">
              <p className="text-sm font-medium text-red-700 dark:text-red-400">{L.deleteTitle}</p>
              <p className="text-sm text-gray-500 mb-2">{L.deleteHint.replace('{hours}', String(hardDelete.waitHours))}</p>
              {org.deletionRequestedAt && org.deletionEligibleAt && (
                <p className="text-sm text-gray-600 dark:text-gray-300 mb-2">
                  {L.deleteRequestedState.replace('{when}', new Date(org.deletionEligibleAt).toLocaleString(locale))}
                </p>
              )}
              <div className="flex flex-wrap gap-3">
                <div className="flex-1 min-w-[160px]">
                  <Input label={L.deleteSlugLabel} value={delSlug} onChange={(e) => setDelSlug(e.target.value)} placeholder={org.slug} autoComplete="off" />
                </div>
                {org.deletionRequestedAt && (
                  <div className="flex-1 min-w-[160px]">
                    <Input label={L.deletePasswordLabel} type="password" value={delPassword} onChange={(e) => setDelPassword(e.target.value)} autoComplete="current-password" />
                  </div>
                )}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {!org.deletionRequestedAt ? (
                  <Button type="button" variant="danger" loading={busy} disabled={delSlug.trim() !== org.slug} onClick={() => deletion('POST')}>
                    {L.deleteRequest}
                  </Button>
                ) : (
                  <>
                    <Button type="button" variant="outline" loading={busy} onClick={() => deletion('DELETE')}>{L.deleteCancel}</Button>
                    <Button type="button" variant="danger" loading={busy} disabled={delSlug.trim() !== org.slug || !delPassword} onClick={() => deletion('EXECUTE')}>
                      {L.deleteExecute}
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}
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
