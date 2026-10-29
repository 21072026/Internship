'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { useLocale, useT } from '@/i18n/client';
import { formatMinorAmount, parseMinorUnits } from '@/lib/money';
import { interpolate } from '@/lib/notificationText';
import { parseReferralUrl, referralLink, type ReferralUrlIssue } from '@/lib/affiliateReferralRule';
import { resyncInFlight, type PlanResyncState } from '@/lib/affiliatePlanResyncRule';
import { AffiliateTabs } from '../AffiliateTabs';

// The programme's settings (docs/affiliate-module.md, #3116): the commission plan
// and the partner contract. The server is the judge (parseCommissionPlan,
// saveContract); this form converts what a person types — "19,99", "15" % — into
// minor units and basis points, and marks the fields the server names.

type Boundary = 'TIER' | 'PERCENT';
type AfterNotice = 'STOP_ALL' | 'RUN_OUT';
interface Plan {
  currency: string;
  tiers: { upToMinor: number; commissionMinor: number }[];
  topCommissionMinor: number;
  percentBps: number;
  switchAtCustomer: number | null;
  boundaryCustomer: Boundary;
  windowMonths: number | null;
  payoutDays: number;
  afterNotice: AfterNotice;
}
interface Settings {
  plan: Plan | null;
  planVersion: number;
  /** The partners' re-evaluation after the last plan change, run on the queue (#3170). */
  planResync: PlanResyncState | null;
  contract: Record<string, string>;
  contractVersion: number;
  referralUrl: string | null;
  currencies: string[];
  canWrite: boolean;
}

const LOCALES = ['en', 'tr', 'de'] as const;

/** Minor units → what the person edits ("1234,50" in de/tr, "1234.50" in en). */
function moneyText(minor: number, locale: string): string {
  const s = (minor / 100).toFixed(2);
  return locale === 'en' ? s : s.replace('.', ',');
}
function percentText(bps: number, locale: string): string {
  const s = String(bps / 100);
  return locale === 'en' ? s : s.replace('.', ',');
}
function parsePercentBps(text: string): number {
  const n = Number(text.trim().replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}
function parseOptionalInt(text: string): number | null {
  const v = text.trim();
  if (v === '') return null;
  return /^\d+$/.test(v) ? Number(v) : NaN;
}

interface Form {
  currency: string;
  tiers: { upTo: string; commission: string }[];
  top: string;
  percent: string;
  switchAt: string;
  boundary: Boundary;
  windowMonths: string;
  payoutDays: string;
  afterNotice: AfterNotice;
}

function formFrom(plan: Plan | null, currency: string, locale: string): Form {
  if (!plan) {
    return { currency, tiers: [{ upTo: '', commission: '' }], top: '', percent: '0', switchAt: '', boundary: 'PERCENT', windowMonths: '', payoutDays: '30', afterNotice: 'RUN_OUT' };
  }
  return {
    currency: plan.currency,
    tiers: plan.tiers.map((t) => ({ upTo: moneyText(t.upToMinor, locale), commission: moneyText(t.commissionMinor, locale) })),
    top: moneyText(plan.topCommissionMinor, locale),
    percent: percentText(plan.percentBps, locale),
    switchAt: plan.switchAtCustomer === null ? '' : String(plan.switchAtCustomer),
    boundary: plan.boundaryCustomer,
    windowMonths: plan.windowMonths === null ? '' : String(plan.windowMonths),
    payoutDays: String(plan.payoutDays),
    afterNotice: plan.afterNotice,
  };
}

function planFrom(f: Form) {
  return {
    currency: f.currency,
    tiers: f.tiers.map((t) => ({ upToMinor: parseMinorUnits(t.upTo), commissionMinor: parseMinorUnits(t.commission) })),
    topCommissionMinor: parseMinorUnits(f.top),
    percentBps: parsePercentBps(f.percent),
    switchAtCustomer: parseOptionalInt(f.switchAt),
    boundaryCustomer: f.boundary,
    windowMonths: parseOptionalInt(f.windowMonths),
    payoutDays: parseOptionalInt(f.payoutDays),
    afterNotice: f.afterNotice,
  };
}

export default function AffiliateSettingsPage() {
  const t = useT();
  const L = t.affiliateSettings;
  const locale = useLocale();
  const toast = useToast();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [failed, setFailed] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [form, setForm] = useState<Form | null>(null);
  const [issues, setIssues] = useState<Set<string>>(new Set());
  const [contract, setContract] = useState<Record<string, string>>({});
  const [referralUrl, setReferralUrl] = useState('');
  const [referralIssue, setReferralIssue] = useState<ReferralUrlIssue | null>(null);
  const [busy, setBusy] = useState<'plan' | 'contract' | 'referral' | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/affiliate/settings');
    if (res.status === 403) {
      setForbidden(true);
      return;
    }
    if (!res.ok) {
      setFailed(true);
      return;
    }
    const s = (await res.json()) as Settings;
    setSettings(s);
    setForm(formFrom(s.plan, s.currencies[0] ?? 'EUR', locale));
    setContract(s.contract ?? {});
    setReferralUrl(s.referralUrl ?? '');
  }, [locale]);

  useEffect(() => {
    void load();
  }, [load]);

  // While the queued re-evaluation runs, follow its progress — only that field,
  // so a form being edited is never reset under the admin's hands.
  const following = resyncInFlight(settings?.planResync ?? null);
  useEffect(() => {
    if (!following) return;
    const timer = setTimeout(async () => {
      const res = await fetch('/api/admin/affiliate/settings').catch(() => null);
      if (!res?.ok) return;
      const s = (await res.json()) as Settings;
      setSettings((prev) => (prev ? { ...prev, planResync: s.planResync } : prev));
    }, 3000);
    return () => clearTimeout(timer);
  }, [following, settings?.planResync]);

  if (forbidden) return <p className="text-sm text-gray-600 dark:text-gray-400">{t.affiliateAdmin.noAccess}</p>;
  if (failed) return <p className="text-sm text-red-600" role="alert">{L.loadFailed}</p>;
  if (!settings || !form) return <SkeletonRows rows={6} />;

  const readOnly = !settings.canWrite;
  const err = (field: string) => (issues.has(field) ? L.errorInvalid : undefined);
  const set = (patch: Partial<Form>) => setForm({ ...form, ...patch });
  // What the server will receive, shown under every money field: "1.000" is a
  // thousand, "0,005" is not half a cent — the person sees it before saving.
  const preview = (text: string) => {
    const minor = parseMinorUnits(text);
    return minor === null || Number.isNaN(minor) ? undefined : interpolate(L.amountPreview, { amount: formatMinorAmount(minor, form.currency, locale) });
  };

  async function savePlan() {
    if (!form) return;
    setBusy('plan');
    setIssues(new Set());
    try {
      const res = await fetch('/api/admin/affiliate/settings/plan', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(planFrom(form)),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        if (!body.changed) toast(L.planUnchanged);
        else {
          toast(interpolate(L.planSaved, { n: String(body.planVersion) }));
          await load();
        }
      } else if (body.code === 'invalid_plan') {
        setIssues(new Set((body.issues ?? []).map((i: { field: string }) => i.field)));
        toast(L.errorInvalid, 'error');
      } else toast(body.code === 'conflict' ? L.errorConflict : L.loadFailed, 'error');
    } finally {
      setBusy(null);
    }
  }

  async function saveContract() {
    setBusy('contract');
    try {
      const res = await fetch('/api/admin/affiliate/settings/contract', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts: contract }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        toast(body.changed ? interpolate(L.contractSaved, { n: String(body.version) }) : L.contractUnchanged);
        if (body.changed) await load();
      } else if (body.code === 'invalid_contract') toast(L.errorEmptyContract, 'error');
      else toast(body.code === 'conflict' ? L.errorConflict : L.loadFailed, 'error');
    } finally {
      setBusy(null);
    }
  }

  async function saveReferral() {
    setBusy('referral');
    setReferralIssue(null);
    try {
      const res = await fetch('/api/admin/affiliate/settings/referral-url', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ referralUrl }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        toast(body.changed ? L.referralSaved : L.referralUnchanged);
        setReferralUrl(body.referralUrl ?? '');
      } else if (body.code === 'invalid_referral_url') {
        setReferralIssue(body.issue);
        toast(L.errorInvalid, 'error');
      } else toast(body.code === 'conflict' ? L.errorConflict : L.loadFailed, 'error');
    } finally {
      setBusy(null);
    }
  }

  const referralPreview = referralLink(referralUrl, L.referralSampleCode);

  const localeLabel: Record<(typeof LOCALES)[number], string> = { en: L.localeEn, tr: L.localeTr, de: L.localeDe };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{L.title}</h1>
      <AffiliateTabs />
      {readOnly && <p className="text-sm text-gray-600 dark:text-gray-400" data-testid="affiliate-settings-readonly">{L.readOnly}</p>}

      <Card>
        <CardHeader>
          <CardTitle>{L.planTitle}</CardTitle>
          <p className="text-sm text-gray-600 dark:text-gray-400">{L.planHint}</p>
          <p className="text-xs text-gray-500" data-testid="affiliate-plan-version">
            {settings.planVersion > 0 ? interpolate(L.planVersion, { n: String(settings.planVersion) }) : L.planNone}
          </p>
        </CardHeader>
        <fieldset disabled={readOnly} className="space-y-4">
          <Input label={L.currency} value={form.currency} readOnly />

          <div className="space-y-2">
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{L.tiers}</p>
            {form.tiers.map((tier, i) => (
              <div key={i} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] items-end gap-2" data-testid={`affiliate-tier-${i}`}>
                <Input
                  label={L.tierUpTo}
                  inputMode="decimal"
                  value={tier.upTo}
                  hint={preview(tier.upTo)}
                  error={err(`tiers.${i}.upToMinor`)}
                  onChange={(e) => set({ tiers: form.tiers.map((x, j) => (j === i ? { ...x, upTo: e.target.value } : x)) })}
                />
                <Input
                  label={L.tierCommission}
                  inputMode="decimal"
                  value={tier.commission}
                  hint={preview(tier.commission)}
                  error={err(`tiers.${i}.commissionMinor`)}
                  onChange={(e) => set({ tiers: form.tiers.map((x, j) => (j === i ? { ...x, commission: e.target.value } : x)) })}
                />
                <Button type="button" variant="ghost" onClick={() => set({ tiers: form.tiers.filter((_, j) => j !== i) })}>
                  {L.removeTier}
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" onClick={() => set({ tiers: [...form.tiers, { upTo: '', commission: '' }] })}>
              {L.addTier}
            </Button>
          </div>

          <Input label={L.topCommission} hint={preview(form.top)} inputMode="decimal" value={form.top} error={err('topCommissionMinor')} onChange={(e) => set({ top: e.target.value })} />
          <Input label={L.percent} hint={L.percentHint} inputMode="decimal" value={form.percent} error={err('percentBps')} onChange={(e) => set({ percent: e.target.value })} />
          <Input label={L.switchAtCustomer} hint={L.switchHint} inputMode="numeric" value={form.switchAt} error={err('switchAtCustomer')} onChange={(e) => set({ switchAt: e.target.value })} />
          <Select
            label={L.boundary}
            value={form.boundary}
            onChange={(e) => set({ boundary: e.target.value as Boundary })}
            options={[
              { value: 'TIER', label: L.boundaryTier },
              { value: 'PERCENT', label: L.boundaryPercent },
            ]}
          />
          <Input label={L.windowMonths} hint={L.windowHint} inputMode="numeric" value={form.windowMonths} error={err('windowMonths')} onChange={(e) => set({ windowMonths: e.target.value })} />
          <Input label={L.payoutDays} inputMode="numeric" value={form.payoutDays} error={err('payoutDays')} onChange={(e) => set({ payoutDays: e.target.value })} />
          <Select
            label={L.afterNotice}
            value={form.afterNotice}
            onChange={(e) => set({ afterNotice: e.target.value as AfterNotice })}
            options={[
              { value: 'STOP_ALL', label: L.afterNoticeStop },
              { value: 'RUN_OUT', label: L.afterNoticeRunOut },
            ]}
          />
          {settings.planResync && <ResyncStatus state={settings.planResync} L={L} />}
          {!readOnly && (
            <Button type="button" onClick={() => void savePlan()} disabled={busy !== null} data-testid="affiliate-save-plan">
              {L.savePlan}
            </Button>
          )}
        </fieldset>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{L.referralTitle}</CardTitle>
          <p className="text-sm text-gray-600 dark:text-gray-400">{L.referralHint}</p>
        </CardHeader>
        <fieldset disabled={readOnly} className="space-y-3">
          <Input
            label={L.referralLabel}
            type="url"
            inputMode="url"
            placeholder="https://"
            value={referralUrl}
            error={referralIssue ? L.referralErrors[referralIssue] : undefined}
            hint={referralPreview ? interpolate(L.referralExample, { code: L.referralSampleCode, link: referralPreview }) : undefined}
            onChange={(e) => {
              // A stale refusal would hide the example link while the address is being fixed (#3176).
              setReferralUrl(e.target.value);
              setReferralIssue(null);
            }}
            onBlur={() => {
              // The server's own rule, so the hint never disagrees with the save; the server still decides.
              const parsed = parseReferralUrl(referralUrl);
              setReferralIssue(parsed.ok ? null : parsed.issue);
            }}
            data-testid="affiliate-referral-url"
          />
          {!readOnly && (
            <Button type="button" onClick={() => void saveReferral()} disabled={busy !== null} data-testid="affiliate-save-referral">
              {L.saveReferral}
            </Button>
          )}
        </fieldset>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{L.contractTitle}</CardTitle>
          <p className="text-sm text-gray-600 dark:text-gray-400">{L.contractHint}</p>
          <p className="text-xs text-gray-500" data-testid="affiliate-contract-version">
            {settings.contractVersion > 0 ? interpolate(L.contractVersion, { n: String(settings.contractVersion) }) : L.contractNone}
          </p>
        </CardHeader>
        <fieldset disabled={readOnly} className="space-y-4">
          {LOCALES.map((l) => (
            <label key={l} className="block space-y-1">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{localeLabel[l]}</span>
              <Textarea
                rows={8}
                lang={l}
                value={contract[l] ?? ''}
                onChange={(e) => setContract({ ...contract, [l]: e.target.value })}
                data-testid={`affiliate-contract-${l}`}
              />
            </label>
          ))}
          {!readOnly && (
            <Button type="button" onClick={() => void saveContract()} disabled={busy !== null} data-testid="affiliate-save-contract">
              {L.saveContract}
            </Button>
          )}
        </fieldset>
      </Card>
    </div>
  );
}

// Where the partners' re-evaluation after the last plan change stands (#3170).
function ResyncStatus({ state, L }: { state: PlanResyncState; L: ReturnType<typeof useT>['affiliateSettings'] }) {
  const n = (x: number | null) => String(x ?? 0);
  const text =
    state.status === 'QUEUED'
      ? L.resyncQueued
      : state.status === 'RUNNING'
        ? interpolate(L.resyncRunning, { done: n(state.done), total: n(state.total) })
        : state.status === 'RETRYING'
          ? interpolate(L.resyncRetrying, { done: n(state.done), failed: n(state.failed) })
          : state.status === 'DONE'
            ? interpolate(L.resyncDone, { n: String(state.v), done: n(state.done) })
            : interpolate(L.resyncFailed, { n: n(state.failed) });
  const warn = state.status === 'INCOMPLETE' || (state.status === 'DONE' && state.drift > 0);
  return (
    <div className={`text-sm ${warn ? 'text-amber-700 dark:text-amber-400' : 'text-gray-600 dark:text-gray-400'}`} role="status" data-testid="affiliate-plan-resync" data-status={state.status}>
      <p>{text}</p>
      {state.drift > 0 && state.status !== 'QUEUED' && <p>{interpolate(L.planDrift, { n: String(state.drift) })}</p>}
    </div>
  );
}
