'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Check, Copy } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useT, useLocale } from '@/i18n/client';
import { locales, type Locale } from '@/i18n/config';
import { ORG_PLANS, orgPlanHasFeature, planIncludingFeature, type OrgPlan } from '@/lib/orgPlans';
import { resolveBranding, isHexColor } from '@/lib/branding';
import { slugifyOrg } from '@/lib/orgSlug';
import { verticalHasCapability } from '@/lib/verticals';
import { copyToClipboard } from '@/lib/clipboard';

// Tenant provisioning wizard (#2065): identity → plan → branding → starter
// pack + first admin → review. One POST at the end; the server applies every
// choice inside one transaction (src/lib/orgProvisioning.ts) and this page
// never posts anything but the choices.
//
// A reload keeps the work: the step is in the URL (`?step=`), the values in
// sessionStorage — per tab, gone when the tab closes, and never in the URL,
// where the first admin's address would end up in history and logs.

const STEPS = ['identity', 'plan', 'branding', 'starter', 'review'] as const;
const DRAFT_KEY = 'org-wizard-draft';

interface Draft {
  name: string;
  slug: string;
  slugEdited: boolean;
  vertical: string;
  plan: OrgPlan;
  brandName: string;
  brandLogoUrl: string;
  brandColor: string;
  supportEmail: string;
  starterPack: boolean;
  sampleProgram: boolean;
  firstAdminEmail: string;
  firstAdminLocale: Locale;
}

type SlugState = 'idle' | 'checking' | 'available' | 'taken' | 'invalid';

interface Created {
  organization: { id: string; name: string; slug: string };
  invitation: { registerUrl: string; emailSent: boolean } | null;
}

function readStep(): number {
  try {
    const n = Number(new URLSearchParams(window.location.search).get('step'));
    return Number.isInteger(n) && n >= 1 && n <= STEPS.length ? n : 1;
  } catch {
    return 1;
  }
}

export default function NewOrganizationPage() {
  const t = useT();
  const W = t.orgWizard;
  const uiLocale = useLocale();
  const blank: Draft = useMemo(
    () => ({
      name: '', slug: '', slugEdited: false, vertical: '', plan: 'FREE',
      brandName: '', brandLogoUrl: '', brandColor: '', supportEmail: '',
      starterPack: true, sampleProgram: false, firstAdminEmail: '', firstAdminLocale: uiLocale,
    }),
    [uiLocale],
  );
  const [draft, setDraft] = useState<Draft>(blank);
  const [step, setStep] = useState(1);
  const [ready, setReady] = useState(false);
  const [verticals, setVerticals] = useState<string[]>([]);
  const [superAdmin, setSuperAdmin] = useState<boolean | null>(null);
  const [slugState, setSlugState] = useState<SlugState>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState(false);

  // Restore the step and the values after mount (neither exists on the server).
  useEffect(() => {
    setStep(readStep());
    try {
      const saved = sessionStorage.getItem(DRAFT_KEY);
      if (saved) setDraft({ ...blank, ...(JSON.parse(saved) as Partial<Draft>) });
    } catch { /* storage blocked or junk: start blank */ }
    setReady(true);
  }, [blank]);

  useEffect(() => {
    if (!ready) return;
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* storage blocked: the wizard still works */ }
  }, [draft, ready]);

  const goTo = useCallback((n: number) => {
    setStep(n);
    setError(null);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('step', String(n));
      window.history.replaceState(null, '', url.toString());
    } catch { /* no URL to update */ }
  }, []);

  // Which products this super admin may create, and whether it is one at all.
  useEffect(() => {
    void (async () => {
      const res = await fetch('/api/admin/organizations');
      if (!res.ok) { setSuperAdmin(false); return; }
      const data = await res.json();
      setSuperAdmin(Boolean(data.superAdmin));
      const offered: string[] = data.verticals ?? [];
      setVerticals(offered);
      setDraft((d) => (d.vertical && offered.includes(d.vertical) ? d : { ...d, vertical: offered[0] ?? '' }));
    })();
  }, []);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const setName = (name: string) => setDraft((d) => ({ ...d, name, slug: d.slugEdited ? d.slug : slugifyOrg(name) }));

  // Slug uniqueness, asked as you type (debounced); create re-checks it.
  useEffect(() => {
    const slug = slugifyOrg(draft.slug);
    if (!slug) { setSlugState(draft.name.trim() ? 'invalid' : 'idle'); return; }
    setSlugState('checking');
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/admin/organizations/slug-availability?slug=${encodeURIComponent(slug)}`);
        const d = await res.json();
        setSlugState(d.available ? 'available' : 'taken');
      } catch {
        setSlugState('idle');
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [draft.slug, draft.name]);

  const brandingAllowed = orgPlanHasFeature(draft.plan, 'WHITE_LABEL');
  const sampleAllowed = draft.starterPack && verticalHasCapability(draft.vertical, 'mentorship');
  const canAdvance = step !== 1 || (draft.name.trim() !== '' && draft.vertical !== '' && slugState === 'available');
  const brandColorOk = !draft.brandColor.trim() || isHexColor(draft.brandColor);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: draft.name.trim(),
          slug: slugifyOrg(draft.slug),
          vertical: draft.vertical,
          plan: draft.plan,
          ...(brandingAllowed
            ? { brandName: draft.brandName, brandLogoUrl: draft.brandLogoUrl, brandColor: draft.brandColor, supportEmail: draft.supportEmail.trim() }
            : {}),
          starterPack: draft.starterPack,
          sampleProgram: sampleAllowed && draft.sampleProgram,
          ...(draft.firstAdminEmail.trim() ? { firstAdminEmail: draft.firstAdminEmail.trim(), firstAdminLocale: draft.firstAdminLocale } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const known: Record<string, string> = {
          slug_taken: W.errors.slugTaken,
          slug_invalid: W.errors.slugInvalid,
          email_taken_in_world: W.errors.emailTaken,
          invalid_brand_color: W.errors.brandColor,
          invalid_brand_logo: W.errors.brandLogo,
          feature_locked: W.errors.featureLocked,
          vertical_other_world: W.errors.vertical,
        };
        setError(known[data.code as string] ?? W.errors.generic);
        return;
      }
      setCreated({ organization: data.organization, invitation: data.invitation ?? null });
      try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* nothing to clear */ }
    } catch {
      setError(W.errors.generic);
    } finally {
      setBusy(false);
    }
  };

  const preview = resolveBranding({ brandName: draft.brandName, brandLogoUrl: draft.brandLogoUrl, brandColor: brandColorOk ? draft.brandColor : '' }, draft.name);
  const limit = (n: number | null) => (n == null ? W.unlimited : String(n));
  const fieldClass = 'block w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm dark:border-gray-700 dark:bg-gray-900';

  return (
    <div className="max-w-3xl">
      <Link href="/admin/organizations" className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 dark:hover:text-gray-100">
        <ArrowLeft className="h-4 w-4" aria-hidden /> {W.backToList}
      </Link>
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{W.title}</h1>
      <p className="mt-1 mb-6 text-gray-500">{W.subtitle}</p>

      {superAdmin === false && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200" data-testid="org-wizard-forbidden">
          {W.notSuperAdmin}
        </p>
      )}

      {superAdmin && created && (
        <Card data-testid="org-wizard-done">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{W.done.replace('{name}', created.organization.name)}</h2>
          {created.invitation ? (
            <div className="mt-3 space-y-2 text-sm">
              <p className="text-gray-600 dark:text-gray-300">{created.invitation.emailSent ? W.doneInvited : W.doneInviteNotSent}</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-gray-100 px-2 py-1 font-mono text-xs dark:bg-gray-800" data-testid="org-wizard-register-url">
                  {created.invitation.registerUrl}
                </code>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    if (await copyToClipboard(created.invitation!.registerUrl)) { setCopied(true); setTimeout(() => setCopied(false), 2000); }
                  }}
                >
                  {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
                  {copied ? W.copied : W.copy}
                </Button>
              </div>
            </div>
          ) : (
            <p className="mt-3 text-sm text-gray-600 dark:text-gray-300">{W.doneNoAdmin}</p>
          )}
          <Link href="/admin/organizations" className="mt-4 inline-block text-sm font-medium text-blue-600 hover:underline">{W.backToList}</Link>
        </Card>
      )}

      {superAdmin && !created && (
        <>
          <ol className="mb-4 flex flex-wrap gap-2 text-xs" aria-label={W.progress}>
            {STEPS.map((key, i) => (
              <li
                key={key}
                aria-current={step === i + 1 ? 'step' : undefined}
                className={`rounded-full px-3 py-1 font-medium ${
                  step === i + 1 ? 'bg-blue-600 text-white' : i + 1 < step ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'
                }`}
              >
                {i + 1}. {W.steps[key]}
              </li>
            ))}
          </ol>

          <Card data-testid={`org-wizard-step-${step}`}>
            <p className="mb-4 text-xs font-medium uppercase tracking-wide text-gray-500">{W.stepOf.replace('{n}', String(step)).replace('{total}', String(STEPS.length))}</p>

            {step === 1 && (
              <div className="space-y-4">
                <Input label={W.name} value={draft.name} onChange={(e) => setName(e.target.value)} maxLength={120} required data-testid="org-wizard-name" />
                <div>
                  <Input
                    label={W.slug}
                    value={draft.slug}
                    onChange={(e) => setDraft((d) => ({ ...d, slug: e.target.value, slugEdited: true }))}
                    maxLength={60}
                    data-testid="org-wizard-slug"
                  />
                  <p className="mt-1 text-xs" data-testid="org-wizard-slug-status" data-state={slugState}>
                    {slugState === 'checking' && <span className="text-gray-500">{W.slugChecking}</span>}
                    {slugState === 'available' && <span className="text-green-700">{W.slugAvailable.replace('{slug}', slugifyOrg(draft.slug))}</span>}
                    {slugState === 'taken' && <span className="text-red-600">{W.slugTaken}</span>}
                    {slugState === 'invalid' && <span className="text-red-600">{W.slugInvalid}</span>}
                    {slugState === 'idle' && <span className="text-gray-500">{W.slugHint}</span>}
                  </p>
                </div>
                {verticals.length > 1 && (
                  <div>
                    <label htmlFor="org-wizard-vertical" className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">{W.product}</label>
                    <select id="org-wizard-vertical" data-testid="org-wizard-vertical" value={draft.vertical} onChange={(e) => set('vertical', e.target.value)} className={fieldClass}>
                      {verticals.map((v) => <option key={v} value={v}>{v}</option>)}
                    </select>
                  </div>
                )}
              </div>
            )}

            {step === 2 && (
              <div>
                <p className="mb-3 text-sm text-gray-600 dark:text-gray-300">{W.planHint}</p>
                <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label={W.steps.plan}>
                  {ORG_PLANS.map((p) => (
                    <button
                      key={p.key}
                      type="button"
                      role="radio"
                      aria-checked={draft.plan === p.key}
                      onClick={() => set('plan', p.key)}
                      data-testid={`org-wizard-plan-${p.key}`}
                      className={`rounded-xl border p-4 text-left ${draft.plan === p.key ? 'border-blue-600 ring-2 ring-blue-200' : 'border-gray-200 hover:border-gray-300 dark:border-gray-700'}`}
                    >
                      <span className="block font-semibold text-gray-900 dark:text-gray-100">{p.key}</span>
                      <span className="mt-2 block text-xs text-gray-600 dark:text-gray-300">{W.limitUsers.replace('{n}', limit(p.limits.maxUsers))}</span>
                      <span className="block text-xs text-gray-600 dark:text-gray-300">{W.limitRelations.replace('{n}', limit(p.limits.maxActiveRelations))}</span>
                      <span className="block text-xs text-gray-600 dark:text-gray-300">{W.limitProjects.replace('{n}', limit(p.limits.maxProjects))}</span>
                      {orgPlanHasFeature(p.key, 'WHITE_LABEL') && <span className="mt-2 block text-xs font-medium text-blue-700">{W.includesBranding}</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {step === 3 && (
              brandingAllowed ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-4">
                    <Input label={W.brandName} value={draft.brandName} onChange={(e) => set('brandName', e.target.value)} maxLength={191} data-testid="org-wizard-brand-name" />
                    <Input label={W.brandLogoUrl} value={draft.brandLogoUrl} onChange={(e) => set('brandLogoUrl', e.target.value)} placeholder="https://" maxLength={2000} />
                    <Input
                      label={W.brandColor}
                      value={draft.brandColor}
                      onChange={(e) => set('brandColor', e.target.value)}
                      placeholder="#2563eb"
                      maxLength={40}
                      error={brandColorOk ? undefined : W.errors.brandColor}
                      data-testid="org-wizard-brand-color"
                    />
                    <Input label={W.supportEmail} type="email" value={draft.supportEmail} onChange={(e) => set('supportEmail', e.target.value)} maxLength={191} />
                  </div>
                  <div>
                    <p className="mb-1.5 text-sm font-medium text-gray-700 dark:text-gray-300">{W.preview}</p>
                    <div className="overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700" data-testid="org-wizard-preview">
                      <div className="flex items-center gap-2 px-4 py-3 text-white" style={{ backgroundColor: preview.color ?? '#2563eb' }}>
                        {preview.logoUrl && /^(https:|\/|data:image\/)/.test(preview.logoUrl) && (
                          // eslint-disable-next-line @next/next/no-img-element -- a preview of an arbitrary tenant URL, not a static asset
                          <img src={preview.logoUrl} alt="" className="h-6 w-6 rounded bg-white object-contain" />
                        )}
                        <span className="font-semibold">{preview.name}</span>
                      </div>
                      <div className="bg-white px-4 py-6 text-sm text-gray-500 dark:bg-gray-900">{W.previewBody}</div>
                    </div>
                  </div>
                </div>
              ) : (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200" data-testid="org-wizard-branding-locked">
                  {W.brandingLocked.replace('{plan}', planIncludingFeature('WHITE_LABEL') ?? '')}
                </p>
              )
            )}

            {step === 4 && (
              <div className="space-y-4">
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" checked={draft.starterPack} onChange={(e) => set('starterPack', e.target.checked)} className="mt-0.5" data-testid="org-wizard-starter" />
                  <span>
                    <span className="font-medium text-gray-900 dark:text-gray-100">{W.starterLabel}</span>
                    <span className="block text-gray-500">{t.orgStarterPack.body}</span>
                  </span>
                </label>
                {draft.starterPack && (
                  <ul className="ml-6 list-disc text-sm text-gray-600 dark:text-gray-300" data-testid="org-wizard-starter-list">
                    {(['stages', 'slas', 'documentRequirements', 'evaluationTemplates', 'goalTemplates'] as const).map((m) => (
                      <li key={m}>{t.orgStarterPack.models[m]}</li>
                    ))}
                  </ul>
                )}
                {sampleAllowed && (
                  <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" checked={draft.sampleProgram} onChange={(e) => set('sampleProgram', e.target.checked)} className="mt-0.5" data-testid="org-wizard-sample" />
                    <span>
                      <span className="font-medium text-gray-900 dark:text-gray-100">{t.orgStarterPack.sampleLabel}</span>
                      <span className="block text-gray-500">{t.orgStarterPack.sampleNote}</span>
                    </span>
                  </label>
                )}
                <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                  <Input
                    label={W.firstAdmin}
                    type="email"
                    value={draft.firstAdminEmail}
                    onChange={(e) => set('firstAdminEmail', e.target.value)}
                    maxLength={191}
                    data-testid="org-wizard-admin-email"
                  />
                  <div>
                    <label htmlFor="org-wizard-admin-locale" className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">{W.firstAdminLanguage}</label>
                    <select id="org-wizard-admin-locale" value={draft.firstAdminLocale} onChange={(e) => set('firstAdminLocale', e.target.value as Locale)} className={fieldClass}>
                      {locales.map((l) => <option key={l} value={l}>{t.account.languages[l]}</option>)}
                    </select>
                  </div>
                </div>
                <p className="text-xs text-gray-500">{W.firstAdminHint}</p>
              </div>
            )}

            {step === 5 && (
              <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]" data-testid="org-wizard-review">
                <dt className="text-gray-500">{W.name}</dt><dd className="font-medium text-gray-900 dark:text-gray-100">{draft.name}</dd>
                <dt className="text-gray-500">{W.slug}</dt><dd className="font-mono text-gray-900 dark:text-gray-100">{slugifyOrg(draft.slug)}</dd>
                <dt className="text-gray-500">{W.product}</dt><dd className="text-gray-900 dark:text-gray-100">{draft.vertical}</dd>
                <dt className="text-gray-500">{W.steps.plan}</dt><dd className="text-gray-900 dark:text-gray-100">{draft.plan}</dd>
                <dt className="text-gray-500">{W.steps.branding}</dt>
                <dd className="text-gray-900 dark:text-gray-100">{brandingAllowed && draft.brandName.trim() ? draft.brandName : W.reviewNoBranding}</dd>
                <dt className="text-gray-500">{W.steps.starter}</dt>
                <dd className="text-gray-900 dark:text-gray-100">
                  {draft.starterPack ? (sampleAllowed && draft.sampleProgram ? W.reviewStarterWithSample : W.reviewStarter) : W.reviewNoStarter}
                </dd>
                <dt className="text-gray-500">{W.firstAdmin}</dt>
                <dd className="text-gray-900 dark:text-gray-100">{draft.firstAdminEmail.trim() || W.reviewNoAdmin}</dd>
              </dl>
            )}

            {error && <p className="mt-4 text-sm text-red-600" role="alert" data-testid="org-wizard-error">{error}</p>}

            <div className="mt-6 flex items-center justify-between gap-2">
              <Button type="button" variant="outline" onClick={() => goTo(step - 1)} disabled={step === 1 || busy} data-testid="org-wizard-back">
                {W.back}
              </Button>
              {step < STEPS.length ? (
                <Button type="button" onClick={() => goTo(step + 1)} disabled={!canAdvance || (step === 3 && brandingAllowed && !brandColorOk)} data-testid="org-wizard-next">
                  {W.next}
                </Button>
              ) : (
                <Button type="button" onClick={() => void create()} loading={busy} data-testid="org-wizard-create">
                  {W.create}
                </Button>
              )}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
