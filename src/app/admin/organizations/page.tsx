'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Copy, Check, Share2, UserPlus, X } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useT, useLocale } from '@/i18n/client';
import { locales, type Locale } from '@/i18n/config';
import { copyToClipboard } from '@/lib/clipboard';
import { orgPlanHasFeature, type OrgPlan, type OrgPlanLimits } from '@/lib/orgPlans';
import { SsoRoleMappings } from '@/components/admin/SsoRoleMappings';

interface Organization {
  id: string;
  name: string;
  slug: string;
  plan: OrgPlan;
  vertical: string;
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
    spEntityId: string;
    acsUrl: string;
    metadataUrl: string;
    // Enforced SSO (#1950).
    ssoEnforced: boolean;
    exemptAdmins: number;
    sessionsToEnd: number;
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

// One read-only SP identifier plus a copy button (#1931). The values come from
// the API, never recomputed here — see the comment on the GET handler. `link`
// makes the value clickable so IT can open the metadata document itself.
function SpRow({ label, value, testId, link }: { label: string; value: string; testId: string; link?: boolean }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <div className="flex items-center gap-2 mt-0.5">
        {link ? (
          <a
            href={value}
            target="_blank"
            rel="noreferrer"
            data-testid={testId}
            // min-w-0 + truncate: these URLs are long, and without it the flex
            // item refuses to shrink and pushes the copy button out of the box.
            className="flex-1 min-w-0 truncate font-mono text-xs text-gray-700 underline decoration-dotted"
          >
            {value}
          </a>
        ) : (
          <code data-testid={testId} className="flex-1 min-w-0 truncate font-mono text-xs text-gray-700">{value}</code>
        )}
        <button
          type="button"
          // type="button": this block lives inside the SSO <form>, and a bare
          // button would submit it.
          data-testid={`copy-${testId}`}
          onClick={async () => {
            if (!(await copyToClipboard(value))) return;
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? t.organizations.spCopied : t.organizations.spCopy}
        </button>
      </div>
    </div>
  );
}

// Locked state for a premium editor (#1742). Cosmetic only — the gate is the
// 403 from PATCH /api/admin/organizations; this just stops an admin filling in
// a form whose save can only fail.
function LockedNote({ text, testId }: { text: string; testId: string }) {
  return (
    <p
      data-testid={testId}
      className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
    >
      {text}
    </p>
  );
}

// Invite a person as ADMIN into one organization — typically the first admin of
// a new MARKETING tenant (docs/worlds.md § İkinci dünyaya davet). Super-admin
// only; the server is the control (POST /api/admin/organizations/[id]/invite-
// admin), this panel is just the door. Built for a phone: an operator setting
// up a tenant on the go gets the register link back with Copy and (where the
// browser has it) the native share sheet, whether or not the mail went out.
function InviteAdminPanel({ org, onClose }: { org: Organization; onClose: () => void }) {
  const t = useT();
  const uiLocale = useLocale();
  const [email, setEmail] = useState('');
  const [label, setLabel] = useState('');
  const [locale, setLocale] = useState<Locale>(uiLocale);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ registerUrl: string; emailSent: boolean; email: string | null } | null>(null);
  const [copied, setCopied] = useState(false);
  // Decided after mount: `navigator` does not exist during the server render,
  // and a button that appears only on the client would be a hydration mismatch.
  const [canShare, setCanShare] = useState(false);
  useEffect(() => {
    setCanShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/organizations/${org.id}/invite-admin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), label: label.trim() || null, locale }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          data.code === 'email_taken_in_world'
            ? t.organizations.inviteEmailTaken
            : data.code === 'invitation_pending'
              ? t.organizations.invitePending
              : data.error || t.common.error
        );
        return;
      }
      setResult({ registerUrl: data.registerUrl, emailSent: !!data.emailSent, email: email.trim() || null });
    } finally {
      setBusy(false);
    }
  };

  const share = async () => {
    if (!result) return;
    try {
      await navigator.share({ title: t.organizations.inviteShareTitle.replace('{org}', org.name), url: result.registerUrl });
    } catch {
      // Dismissing the share sheet rejects; nothing to report.
    }
  };

  const reset = () => {
    setResult(null);
    setEmail('');
    setLabel('');
    setCopied(false);
  };

  return (
    <Card className="mb-6 max-w-2xl" data-testid="invite-admin-panel">
      <div className="flex items-start justify-between gap-3 mb-3">
        <CardTitle className="min-w-0 break-words">{t.organizations.inviteAdminTitle.replace('{org}', org.name)}</CardTitle>
        <button
          type="button"
          onClick={onClose}
          aria-label={t.organizations.inviteClose}
          data-testid="invite-admin-close"
          className="shrink-0 rounded-md p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {!result ? (
        <form onSubmit={submit} className="space-y-3" data-testid="invite-admin-form">
          <p className="text-sm text-gray-500">{t.organizations.inviteAdminHint}</p>
          <Input
            label={t.organizations.inviteEmail}
            id="invite-admin-email"
            type="email"
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            data-testid="invite-admin-email"
          />
          <Input
            label={t.organizations.inviteLabel}
            id="invite-admin-label"
            value={label}
            maxLength={120}
            onChange={(e) => setLabel(e.target.value)}
            data-testid="invite-admin-label"
          />
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5" htmlFor="invite-admin-locale">
              {t.organizations.inviteLanguage}
            </label>
            <select
              id="invite-admin-locale"
              data-testid="invite-admin-locale"
              value={locale}
              onChange={(e) => setLocale(e.target.value as Locale)}
              className="block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm"
            >
              {locales.map((l) => <option key={l} value={l}>{t.account.languages[l]}</option>)}
            </select>
          </div>
          {error && <p className="text-sm text-red-600" data-testid="invite-admin-error">{error}</p>}
          <Button type="submit" loading={busy} data-testid="invite-admin-submit" className="w-full sm:w-auto">
            {t.organizations.inviteSubmit}
          </Button>
        </form>
      ) : (
        <div className="space-y-3" data-testid="invite-admin-result">
          <p
            data-testid="invite-admin-mail-status"
            className={
              result.emailSent
                ? 'rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-200'
                : 'rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200'
            }
          >
            {result.emailSent
              ? t.organizations.inviteMailSent.replace('{email}', result.email ?? '')
              : result.email
                ? t.organizations.inviteMailNotSent
                : t.organizations.inviteLinkOnly}
          </p>
          <div className="min-w-0">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5" htmlFor="invite-admin-link">
              {t.organizations.inviteLink}
            </label>
            <input
              id="invite-admin-link"
              readOnly
              value={result.registerUrl}
              data-testid="invite-admin-link"
              onFocus={(e) => e.currentTarget.select()}
              className="block w-full min-w-0 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2.5 font-mono text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              data-testid="invite-admin-copy"
              onClick={async () => {
                if (!(await copyToClipboard(result.registerUrl))) return;
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? <Check className="h-4 w-4 mr-1.5" /> : <Copy className="h-4 w-4 mr-1.5" />}
              {copied ? t.organizations.spCopied : t.organizations.spCopy}
            </Button>
            {canShare && (
              <Button type="button" variant="outline" data-testid="invite-admin-share" onClick={share}>
                <Share2 className="h-4 w-4 mr-1.5" />
                {t.organizations.inviteShare}
              </Button>
            )}
            <Button type="button" variant="ghost" data-testid="invite-admin-another" onClick={reset}>
              {t.organizations.inviteAnother}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

export default function AdminOrganizationsPage() {
  const t = useT();
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [plans, setPlans] = useState<OrgPlan[]>([]);
  // Keys come from the server's catalogue (#2350) — never hard-coded here, or
  // adding a vertical would mean editing two lists that can disagree.
  const [verticals, setVerticals] = useState<string[]>([]);
  // Whether this admin may manage every tenant (#1535). Presentation only — the
  // API refuses a cross-tenant write regardless of what is rendered here.
  const [superAdmin, setSuperAdmin] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  // Required (per-world super admins): the server offers only the verticals of
  // this super admin's own world, and the form preselects the first of them.
  const [vertical, setVertical] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  // Which org the "invite admin" panel is open for (super admin only).
  const [inviteOrgId, setInviteOrgId] = useState<string | null>(null);
  const inviteOrg = orgs.find((o) => o.id === inviteOrgId) ?? null;

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/organizations');
    if (res.ok) {
      const data = await res.json();
      setOrgs(data.organizations ?? []);
      setPlans(data.plans ?? []);
      const offered: string[] = data.verticals ?? [];
      setVerticals(offered);
      setVertical((v) => (v && offered.includes(v) ? v : offered[0] ?? ''));
      setSuperAdmin(!!data.superAdmin);
    }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !vertical) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/organizations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, slug, vertical }),
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

  // Which product a tenant is (#2350). Super-admin only on the server; the
  // select is disabled for everyone else to match, but that check is cosmetic —
  // the API is the control.
  const changeVertical = async (id: string, next: string) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/organizations', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, vertical: next }),
      });
      if (res.ok) await load();
      // A move can now be REFUSED (409 `vertical_move_email_conflict`, #2590: it
      // would give one e-mail two accounts in the same product). Say so — the
      // select just snaps back to the stored value, and a silent snap-back reads
      // as "the click did not register". The server's sentence carries a count
      // and no address, so it is safe to show verbatim.
      else setError((await res.json().catch(() => ({}))).error ?? t.common.error);
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
      const failure = data.code === 'feature_locked' ? t.organizations.featureLocked : data.error || t.common.error;
      setBrandMsg(res.ok ? t.organizations.brandingSaved : failure);
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
      const failure = data.code === 'feature_locked' ? t.organizations.featureLocked : data.error || t.common.error;
      setSsoMsg(res.ok ? t.organizations.ssoSaved : failure);
      if (res.ok) { setSsoCertificate(''); await load(); }
    } finally {
      setSaving(false);
    }
  };

  // Is the selected tenant's plan entitled to each premium editor? Nothing is
  // locked until an org is picked (there is no plan to judge before that).
  const brandOrg = orgs.find((o) => o.id === brandOrgId);
  const ssoOrg = orgs.find((o) => o.id === ssoOrgId);
  const brandLocked = !!brandOrgId && !orgPlanHasFeature(brandOrg?.plan, 'WHITE_LABEL');
  const ssoLocked = !!ssoOrgId && !orgPlanHasFeature(ssoOrg?.plan, 'SSO_SAML');

  // Undoing is never gated (the API exempts a payload that can only null
  // columns), so a locked editor still offers the way out: branding a tenant
  // no longer pays for keeps rendering in every branded e-mail and on the
  // certificate PDF until someone removes it, and a dead SSO switch left on is
  // the thing an admin most wants to turn off.
  const brandStored = !!(brandOrg && (brandOrg.branding.brandName || brandOrg.branding.brandLogoUrl
    || brandOrg.branding.brandColor || brandOrg.branding.supportEmail));

  const clearBranding = async () => {
    if (!brandOrgId) return;
    setSaving(true); setBrandMsg(null);
    try {
      const res = await fetch('/api/admin/organizations', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: brandOrgId, brandName: '', brandLogoUrl: '', brandColor: '', supportEmail: '' }),
      });
      const data = await res.json().catch(() => ({}));
      setBrandMsg(res.ok ? t.organizations.brandingSaved : (data.error || t.common.error));
      if (res.ok) { setBrandName(''); setBrandLogoUrl(''); setBrandColor(''); setBrandSupport(''); await load(); }
    } finally {
      setSaving(false);
    }
  };

  // Enforced SSO (#1950). Deliberately its own request rather than a field on
  // the config form: switching it on ENDS every password session in the tenant,
  // and an action with that consequence must be pressed on purpose, after a
  // confirmation that names the number.
  const toggleEnforcement = async (next: boolean) => {
    const org = orgs.find((x) => x.id === ssoOrgId);
    if (!org) return;
    const question = next
      ? t.organizations.ssoEnforceConfirm.replace('{count}', String(org.sso.sessionsToEnd))
      : t.organizations.ssoRelaxConfirm;
    if (!window.confirm(question)) return;
    setSaving(true); setSsoMsg(null);
    try {
      const res = await fetch('/api/admin/organizations', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: ssoOrgId, ssoEnforced: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const blockers: string[] = Array.isArray(data.blockers) ? data.blockers : [];
        setSsoMsg(
          blockers.includes('SSO_NOT_ACTIVE')
            ? t.organizations.ssoEnforceNeedsActive
            : blockers.includes('NO_EXEMPT_ADMIN')
              ? t.organizations.ssoEnforceNeedsExempt
              : data.error || t.common.error
        );
        return;
      }
      setSsoMsg(
        next
          ? t.organizations.ssoEnforceDone.replace('{count}', String(data.sessionsEnded ?? 0))
          : t.organizations.ssoRelaxDone
      );
      await load();
    } finally {
      setSaving(false);
    }
  };

  const disableSso = async () => {
    if (!ssoOrgId) return;
    setSaving(true); setSsoMsg(null);
    try {
      const res = await fetch('/api/admin/organizations', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: ssoOrgId, ssoEnabled: false }),
      });
      const data = await res.json().catch(() => ({}));
      setSsoMsg(res.ok ? t.organizations.ssoSaved : (data.error || t.common.error));
      if (res.ok) { setSsoEnabled(false); await load(); }
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

      {!superAdmin && (
        <div data-testid="tenant-scope-note" className="mb-6 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
          {t.organizations.tenantScopeNote}
        </div>
      )}

      {superAdmin && (
      <Card className="mb-6 max-w-2xl" data-testid="new-org-card">
        <CardHeader><CardTitle>{t.organizations.newOrg}</CardTitle></CardHeader>
        <form onSubmit={create} className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[180px]">
            <Input label={t.organizations.name} value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="flex-1 min-w-[160px]">
            <Input label={t.organizations.slug} value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="acme-inc" />
          </div>
          <div className="flex-1 min-w-[160px]">
            <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="new-org-vertical">
              {t.organizations.vertical}
            </label>
            <select
              id="new-org-vertical"
              data-testid="new-org-vertical"
              value={vertical}
              onChange={(e) => setVertical(e.target.value)}
              required
              className="block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm"
            >
              {verticals.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
          <Button type="submit" loading={saving}>{t.organizations.create}</Button>
        </form>
        <p className="text-xs text-gray-500 mt-2">{t.organizations.slugHint}</p>
        {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
      </Card>
      )}

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
            {brandLocked && <LockedNote testId="branding-locked" text={t.organizations.brandingLocked} />}
            {brandLocked && brandStored && (
              <Button type="button" variant="outline" loading={saving} onClick={clearBranding} data-testid="brand-clear">
                {t.organizations.brandingClear}
              </Button>
            )}
            {brandOrgId && (
              <div className="flex flex-wrap gap-3">
                <div className="flex-1 min-w-[160px]"><Input label={t.organizations.brandName} value={brandName} disabled={brandLocked} onChange={(e) => setBrandName(e.target.value)} placeholder="Internship CRM" /></div>
                <div className="flex-1 min-w-[160px]"><Input label={t.organizations.brandColor} value={brandColor} disabled={brandLocked} onChange={(e) => setBrandColor(e.target.value)} placeholder="#2563eb" /></div>
                <div className="flex-1 min-w-[220px]"><Input label={t.organizations.brandLogoUrl} value={brandLogoUrl} disabled={brandLocked} onChange={(e) => setBrandLogoUrl(e.target.value)} placeholder="https://…/logo.svg" /></div>
                <div className="flex-1 min-w-[200px]"><Input label={t.organizations.brandSupportEmail} type="email" value={brandSupport} disabled={brandLocked} onChange={(e) => setBrandSupport(e.target.value)} placeholder="help@acme.com" /></div>
              </div>
            )}
            {brandOrgId && <Button type="submit" loading={saving} disabled={brandLocked} data-testid="brand-save">{t.common.save}</Button>}
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
            {ssoLocked && <LockedNote testId="sso-locked" text={t.organizations.ssoLocked} />}
            {ssoLocked && ssoOrg?.sso.ssoEnabled && (
              <Button type="button" variant="outline" loading={saving} onClick={disableSso} data-testid="sso-disable">
                {t.organizations.ssoDisable}
              </Button>
            )}
            {ssoOrgId && (
              <>
                {(() => {
                  const o = orgs.find((x) => x.id === ssoOrgId);
                  if (!o) return null;
                  return (
                    <div data-testid="sp-details" className="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2">
                      <p className="text-sm font-medium text-gray-700">{t.organizations.spDetails}</p>
                      <p className="text-xs text-gray-500">{t.organizations.spDetailsHint}</p>
                      <SpRow label={t.organizations.spEntityId} value={o.sso.spEntityId} testId="sp-entity-id" />
                      <SpRow label={t.organizations.spAcsUrl} value={o.sso.acsUrl} testId="sp-acs-url" />
                      <SpRow label={t.organizations.spMetadataUrl} value={o.sso.metadataUrl} testId="sp-metadata-url" link />
                    </div>
                  );
                })()}
                <div className="flex flex-wrap gap-3">
                  <div className="min-w-[140px]">
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.organizations.ssoProvider}</label>
                    <select value={ssoProvider} disabled={ssoLocked} onChange={(e) => setSsoProvider(e.target.value)} className="block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm">
                      <option value="">—</option>
                      <option value="saml">SAML</option>
                      {/* OIDC is a roadmap item: the login route always builds a
                          SAML request, so saving it would lock the tenant out.
                          Shown disabled rather than hidden — it is coming. */}
                      <option value="oidc" disabled>{`OIDC — ${t.organizations.ssoOidcSoon}`}</option>
                    </select>
                  </div>
                  <div className="flex-1 min-w-[200px]"><Input label={t.organizations.ssoIssuer} value={ssoIssuer} disabled={ssoLocked} onChange={(e) => setSsoIssuer(e.target.value)} placeholder="https://idp.example.com/metadata" /></div>
                  <div className="flex-1 min-w-[220px]"><Input label={t.organizations.ssoEntryPoint} value={ssoEntryPoint} disabled={ssoLocked} onChange={(e) => setSsoEntryPoint(e.target.value)} placeholder="https://idp.example.com/sso" /></div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.organizations.ssoCertificate}</label>
                  <textarea
                    value={ssoCertificate}
                    disabled={ssoLocked}
                    onChange={(e) => setSsoCertificate(e.target.value)}
                    rows={3}
                    placeholder="-----BEGIN CERTIFICATE-----"
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-xs font-mono"
                  />
                  <p className="text-xs text-gray-400 mt-1">{t.organizations.ssoCertHint}</p>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" data-testid="sso-enabled" disabled={ssoLocked} checked={ssoEnabled} onChange={(e) => setSsoEnabled(e.target.checked)} />
                  {t.organizations.ssoEnable}
                </label>
                <Button type="submit" loading={saving} disabled={ssoLocked} data-testid="sso-save">{t.common.save}</Button>
                {/* Enforcement is not part of the form above: it is saved on
                    its own, immediately, because it ends live sessions. */}
                <div data-testid="sso-enforce-block" className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-1.5">
                  <label className="flex items-center gap-2 text-sm font-medium text-amber-900">
                    <input
                      type="checkbox"
                      data-testid="sso-enforced"
                      disabled={ssoLocked || saving}
                      checked={ssoOrg?.sso.ssoEnforced ?? false}
                      onChange={(e) => toggleEnforcement(e.target.checked)}
                    />
                    {t.organizations.ssoEnforce}
                  </label>
                  <p className="text-xs text-amber-800">{t.organizations.ssoEnforceHint}</p>
                  <p className="text-xs text-amber-800" data-testid="sso-enforce-readiness">
                    {t.organizations.ssoExemptAdmins.replace('{count}', String(ssoOrg?.sso.exemptAdmins ?? 0))}
                    {' · '}
                    {t.organizations.ssoEnforceSessions.replace('{count}', String(ssoOrg?.sso.sessionsToEnd ?? 0))}
                  </p>
                </div>
              </>
            )}
          </form>
          {ssoMsg && <p className="text-sm text-gray-600 mt-2">{ssoMsg}</p>}
          {/* Keyed by org so switching the selector reloads its own mapping (#1940). */}
          {ssoOrgId && <SsoRoleMappings key={ssoOrgId} orgId={ssoOrgId} locked={ssoLocked} />}
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

      {superAdmin && inviteOrg && (
        <div id="invite-admin-anchor">
          <InviteAdminPanel key={inviteOrg.id} org={inviteOrg} onClose={() => setInviteOrgId(null)} />
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
                  <th className="py-2 pr-4">{t.organizations.vertical}</th>
                  <th className="py-2 pr-4">{t.organizations.users}</th>
                  <th className="py-2 pr-4">{t.organizations.relations}</th>
                  <th className="py-2 pr-4">{t.organizations.projects}</th>
                  <th className="py-2 pr-4">{t.organizations.companies}</th>
                  <th className="py-2 pr-4">{t.organizations.cohorts}</th>
                  <th className="py-2 pr-4">{t.organizations.sources}</th>
                  <th className="py-2 pr-4">{t.organizations.pipeline}</th>
                  {superAdmin && <th className="py-2 pr-4">{t.organizations.admins}</th>}
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
                        // Changing the tier is a billing act and the premium
                        // gate reads it, so the API refuses it for anyone but a
                        // super admin (#1742). Disabled here to match; the
                        // server check is the control.
                        disabled={saving || !superAdmin}
                        onChange={(e) => changePlan(o.id, e.target.value)}
                        className="rounded-lg border border-gray-300 px-2 py-1 text-xs disabled:opacity-60"
                      >
                        {plans.map((p) => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </td>
                    <td className="py-2 pr-4">
                      <select
                        aria-label={t.organizations.vertical}
                        data-testid={`org-vertical-${o.id}`}
                        value={o.vertical}
                        // A super admin's world has one product today, and a
                        // cross-world move is refused by the API (per-world
                        // super admins), so there is nothing to pick.
                        disabled={saving || !superAdmin || verticals.length < 2}
                        onChange={(e) => changeVertical(o.id, e.target.value)}
                        className="rounded-lg border border-gray-300 px-2 py-1 text-xs disabled:opacity-60"
                      >
                        {verticals.map((v) => <option key={v} value={v}>{v}</option>)}
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
                    {superAdmin && (
                      <td className="py-2 pr-4">
                        <button
                          type="button"
                          data-testid={`org-invite-admin-${o.id}`}
                          onClick={() => {
                            setInviteOrgId(o.id);
                            // The panel renders above the list; on a phone the
                            // row is far below it, so bring it into view.
                            requestAnimationFrame(() =>
                              document.getElementById('invite-admin-anchor')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                            );
                          }}
                          className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-blue-600 hover:underline"
                        >
                          <UserPlus className="h-3.5 w-3.5" />
                          {t.organizations.inviteAdmin}
                        </button>
                      </td>
                    )}
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
