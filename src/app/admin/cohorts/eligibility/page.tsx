'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { useLocale, useT } from '@/i18n/client';
import { attributeLabel } from '@/lib/orgAttributesRule';

// The programme eligibility builder (#1945): one scope at a time — the whole
// organisation, or one programme (a Cohort row). Every rule is server-side
// (src/lib/eligibilityRule.ts, enforced by POST /api/mentorship, the apply form,
// SSO JIT and the matching loaders); this page only renders what the API
// answers. The "who does this admit?" line is a dry run against the current
// roster, recomputed for the draft before anything is saved.

interface Rule {
  id: string;
  programId: string | null;
  effect: 'ALLOW' | 'DENY';
  attribute: string;
  operator: string;
  value: unknown;
  priority: number;
  active: boolean;
}
interface Attr { key: string; labelEn: string; labelTr: string; labelDe: string; type: string }
interface Program { id: string; name: string; eligibilityMode: string }
interface Scope {
  orgMode: string;
  program: Program | null;
  programs: Program[];
  rules: Rule[];
  inheritedRules: Rule[];
  fields: string[];
  operators: string[];
  attributes: Attr[];
}

const inputClass = 'rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';

// useSearchParams() needs a Suspense boundary to prerender.
export default function EligibilityPageShell() {
  return (
    <Suspense>
      <EligibilityPage />
    </Suspense>
  );
}

function EligibilityPage() {
  const t = useT();
  const e = t.eligibility;
  const locale = useLocale();
  const router = useRouter();
  const params = useSearchParams();
  const programId = params.get('programId');
  const [scope, setScope] = useState<Scope | null>(null);
  const [mode, setMode] = useState('OPEN');
  const [preview, setPreview] = useState<{ total: number; admitted: number } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ effect: 'ALLOW', attribute: 'department', operator: 'IN', value: '', priority: 0 });

  const api = `/api/admin/eligibility${programId ? `?programId=${encodeURIComponent(programId)}` : ''}`;
  const load = useCallback(async () => {
    const res = await fetch(api);
    if (!res.ok) return;
    const data: Scope = await res.json();
    setScope(data);
    setMode(programId ? data.program?.eligibilityMode ?? 'OPEN' : data.orgMode);
  }, [api, programId]);
  useEffect(() => {
    load();
  }, [load]);

  const savedMode = programId ? scope?.program?.eligibilityMode ?? 'OPEN' : scope?.orgMode ?? 'OPEN';
  const draftValue = useMemo(() => {
    if (draft.operator === 'EXISTS') return draft.value !== 'false';
    if (draft.operator === 'IN' || draft.operator === 'NOT_IN') return draft.value.split(',').map((v) => v.trim()).filter(Boolean);
    return draft.value.trim();
  }, [draft]);
  const draftValid = draft.operator === 'EXISTS' || (Array.isArray(draftValue) ? draftValue.length > 0 : draftValue !== '');

  // The dry run: the scope's saved rules, the pending mode and — when filled
  // in — the rule about to be added. Debounced; it reads, never writes.
  useEffect(() => {
    if (!scope) return;
    const rules = [
      ...scope.rules.map((r) => ({ effect: r.effect, attribute: r.attribute, operator: r.operator, value: r.value, priority: r.priority, active: r.active })),
      ...(draftValid ? [{ ...draft, value: draftValue }] : []),
    ];
    const handle = setTimeout(async () => {
      const res = await fetch('/api/admin/eligibility/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ programId, mode, rules }),
      });
      setPreview(res.ok ? await res.json() : null);
    }, 300);
    return () => clearTimeout(handle);
  }, [scope, mode, draft, draftValue, draftValid, programId]);

  const labelOf = (attribute: string) => {
    if (attribute.startsWith('attr:')) {
      const a = scope?.attributes.find((x) => `attr:${x.key}` === attribute);
      return a ? attributeLabel(a, locale) : attribute.slice(5);
    }
    return (e.fields as Record<string, string>)[attribute] ?? attribute;
  };
  const opLabel = (op: string) => (e.operators as Record<string, string>)[op] ?? op;
  const valueText = (r: Rule) => (typeof r.value === 'boolean' ? (r.value ? e.yes : e.no) : Array.isArray(r.value) ? r.value.join(', ') : String(r.value));

  const call = async (init: RequestInit, url = '/api/admin/eligibility') => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError((e.errors as Record<string, string>)[body.code] ?? e.errors.generic);
        return false;
      }
      await load();
      return true;
    } finally {
      setBusy(false);
    }
  };

  const addRule = async () => {
    const ok = await call({ method: 'POST', body: JSON.stringify({ programId, ...draft, value: draftValue }) });
    if (ok) setDraft((d) => ({ ...d, value: '' }));
  };

  const ruleRow = (r: Rule, editable: boolean) => (
    <tr key={r.id} data-testid={`eligibility-rule-${r.id}`} className="border-t border-gray-100 dark:border-gray-800">
      <td className="py-1.5 pr-3">
        <Badge variant={r.effect === 'ALLOW' ? 'success' : 'danger'}>{r.effect === 'ALLOW' ? e.allow : e.deny}</Badge>
      </td>
      <td className="py-1.5 pr-3">{labelOf(r.attribute)}</td>
      <td className="py-1.5 pr-3">{opLabel(r.operator)}</td>
      <td className="py-1.5 pr-3 break-all">{valueText(r)}</td>
      <td className="py-1.5 pr-3">{r.priority}</td>
      <td className="py-1.5 pr-3">
        {editable ? (
          <input
            type="checkbox"
            aria-label={e.active}
            checked={r.active}
            disabled={busy}
            onChange={(ev) => call({ method: 'PATCH', body: JSON.stringify({ ruleId: r.id, active: ev.target.checked }) })}
          />
        ) : r.active ? e.yes : e.no}
      </td>
      <td className="py-1.5 text-right">
        {editable && (
          <button type="button" aria-label={t.common.delete} disabled={busy} className="text-gray-400 hover:text-red-600" onClick={() => call({ method: 'DELETE' }, `/api/admin/eligibility?ruleId=${encodeURIComponent(r.id)}`)}>
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </td>
    </tr>
  );

  const table = (rules: Rule[], editable: boolean, testId: string) => (
    <table className="w-full text-sm" data-testid={testId}>
      <thead>
        <tr className="text-left text-xs text-gray-500">
          <th className="py-1 pr-3">{e.effect}</th>
          <th className="py-1 pr-3">{e.attribute}</th>
          <th className="py-1 pr-3">{e.operator}</th>
          <th className="py-1 pr-3">{e.value}</th>
          <th className="py-1 pr-3">{e.priority}</th>
          <th className="py-1 pr-3">{e.active}</th>
          <th />
        </tr>
      </thead>
      <tbody>{rules.map((r) => ruleRow(r, editable))}</tbody>
    </table>
  );

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/cohorts" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-blue-600">
          <ArrowLeft className="h-4 w-4" /> {e.back}
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-gray-900 dark:text-gray-100">{e.title}</h1>
        <p className="mt-1 text-gray-500">{e.subtitle}</p>
      </div>

      <Card>
        <label className="flex flex-col gap-1 text-sm text-gray-700 dark:text-gray-300">
          {e.scope}
          <select
            data-testid="eligibility-scope"
            className={`${inputClass} max-w-sm`}
            value={programId ?? ''}
            onChange={(ev) => router.push(ev.target.value ? `/admin/cohorts/eligibility?programId=${encodeURIComponent(ev.target.value)}` : '/admin/cohorts/eligibility')}
          >
            <option value="">{e.orgWide}</option>
            {scope?.programs.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
      </Card>

      <Card>
        <CardHeader><CardTitle>{e.modeTitle}</CardTitle></CardHeader>
        <div className="space-y-2 text-sm">
          {(['OPEN', 'RULES'] as const).map((m) => (
            <label key={m} className="flex items-start gap-2">
              <input type="radio" name="eligibility-mode" data-testid={`eligibility-mode-${m}`} checked={mode === m} onChange={() => setMode(m)} className="mt-1" />
              <span>
                {m === 'OPEN' ? e.modeOpen : e.modeRules}
                <span className="block text-xs text-gray-500">{m === 'OPEN' ? e.modeOpenHint : e.modeRulesHint}</span>
              </span>
            </label>
          ))}
          {programId && scope?.orgMode === 'RULES' && <p className="text-xs text-amber-700 dark:text-amber-400">{e.orgGated}</p>}
          <Button type="button" size="sm" data-testid="eligibility-mode-save" disabled={busy || mode === savedMode} onClick={() => call({ method: 'PATCH', body: JSON.stringify({ programId, mode }) })}>
            {e.saveMode}
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader><CardTitle>{e.rulesTitle}</CardTitle></CardHeader>
        {programId && scope && scope.inheritedRules.length > 0 && (
          <div className="mb-4">
            <p className="mb-1 text-xs font-medium text-gray-500">{e.inherited}</p>
            {table(scope.inheritedRules, false, 'eligibility-inherited')}
          </div>
        )}
        {scope && scope.rules.length === 0 ? (
          <p className="text-sm text-gray-500" data-testid="eligibility-empty">{e.none}</p>
        ) : (
          scope && table(scope.rules, true, 'eligibility-rules')
        )}

        <div className="mt-4 flex flex-wrap items-end gap-2">
          <label className="flex flex-col text-xs text-gray-600 dark:text-gray-300">
            {e.effect}
            <select data-testid="eligibility-effect" className={inputClass} value={draft.effect} onChange={(ev) => setDraft({ ...draft, effect: ev.target.value })}>
              <option value="ALLOW">{e.allow}</option>
              <option value="DENY">{e.deny}</option>
            </select>
          </label>
          <label className="flex flex-col text-xs text-gray-600 dark:text-gray-300">
            {e.attribute}
            <select data-testid="eligibility-attribute" className={inputClass} value={draft.attribute} onChange={(ev) => setDraft({ ...draft, attribute: ev.target.value })}>
              {scope?.fields.map((f) => <option key={f} value={f}>{labelOf(f)}</option>)}
              {scope?.attributes.map((a) => <option key={a.key} value={`attr:${a.key}`}>{attributeLabel(a, locale)}</option>)}
            </select>
          </label>
          <label className="flex flex-col text-xs text-gray-600 dark:text-gray-300">
            {e.operator}
            <select data-testid="eligibility-operator" className={inputClass} value={draft.operator} onChange={(ev) => setDraft({ ...draft, operator: ev.target.value, value: '' })}>
              {scope?.operators.map((o) => <option key={o} value={o}>{opLabel(o)}</option>)}
            </select>
          </label>
          <label className="flex flex-col text-xs text-gray-600 dark:text-gray-300">
            {e.value}
            {draft.operator === 'EXISTS' ? (
              <select data-testid="eligibility-value" className={inputClass} value={draft.value || 'true'} onChange={(ev) => setDraft({ ...draft, value: ev.target.value })}>
                <option value="true">{e.yes}</option>
                <option value="false">{e.no}</option>
              </select>
            ) : (
              <input
                data-testid="eligibility-value"
                className={inputClass}
                value={draft.value}
                placeholder={draft.operator === 'IN' || draft.operator === 'NOT_IN' ? e.listPlaceholder : ''}
                onChange={(ev) => setDraft({ ...draft, value: ev.target.value })}
              />
            )}
          </label>
          <label className="flex flex-col text-xs text-gray-600 dark:text-gray-300">
            {e.priority}
            <input
              data-testid="eligibility-priority"
              type="number"
              className={`${inputClass} w-20`}
              value={draft.priority}
              onChange={(ev) => setDraft({ ...draft, priority: Number(ev.target.value) || 0 })}
            />
          </label>
          <Button type="button" size="sm" data-testid="eligibility-add" loading={busy} disabled={!draftValid} onClick={addRule}>
            {e.add}
          </Button>
        </div>
        {error && <p className="mt-2 text-xs text-red-600" role="alert">{error}</p>}
        <p className="mt-2 text-xs text-gray-500">{e.precedence}</p>
      </Card>

      <Card>
        <p data-testid="eligibility-preview" className="text-sm text-gray-800 dark:text-gray-200">
          {preview ? e.preview.replace('{admitted}', String(preview.admitted)).replace('{total}', String(preview.total)) : e.previewPending}
        </p>
      </Card>
    </div>
  );
}
