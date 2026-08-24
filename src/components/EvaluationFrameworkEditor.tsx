'use client';

// The org's competency framework, editable without a code change (#822).
//
// Two rubrics — what a mentor scores a mentee on, and what a mentee scores a
// mentor on — each a list of criteria with a stable key and a label per
// language. An org that has not touched this sees the built-in four in each
// list and keeps them until it saves something of its own; emptying a list puts
// the built-ins back.

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Plus, Trash2 } from 'lucide-react';
import { useT } from '@/i18n/client';
import { locales, type Locale } from '@/i18n/config';
import { EVALUATION_SCOPES, type EvaluationScope } from '@/lib/evaluation';

interface Row {
  key: string;
  labels: Partial<Record<Locale, string>>;
  // Built-in rows arrive with no labels of their own; their wording comes from
  // the dictionary until an admin edits them into the tenant's own framework.
  builtIn: boolean;
}

type ScopeState = { isCustom: boolean; rows: Row[] };

export function EvaluationFrameworkEditor() {
  const t = useT();
  const [state, setState] = useState<Record<EvaluationScope, ScopeState>>({
    MENTEE: { isCustom: false, rows: [] },
    MENTOR: { isCustom: false, rows: [] },
  });
  const [saving, setSaving] = useState<EvaluationScope | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const builtInLabel = (key: string) => (t.evaluation.criteria as Record<string, string>)[key] ?? key;

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/evaluation-templates');
    if (!res.ok) return;
    const { scopes } = await res.json();
    const next = {} as Record<EvaluationScope, ScopeState>;
    for (const scope of EVALUATION_SCOPES) {
      const s = scopes[scope];
      next[scope] = {
        isCustom: !!s?.isCustom,
        rows: (s?.criteria ?? []).map((c: { key: string; labels: Record<string, string> | null }) => ({
          key: c.key,
          labels: c.labels ?? {},
          builtIn: !c.labels,
        })),
      };
    }
    setState(next);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const patchRow = (scope: EvaluationScope, i: number, patch: Partial<Row>) =>
    setState((p) => ({
      ...p,
      [scope]: { ...p[scope], rows: p[scope].rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) },
    }));

  const removeRow = (scope: EvaluationScope, i: number) =>
    setState((p) => ({ ...p, [scope]: { ...p[scope], rows: p[scope].rows.filter((_, j) => j !== i) } }));

  const addRow = (scope: EvaluationScope) =>
    setState((p) => ({ ...p, [scope]: { ...p[scope], rows: [...p[scope].rows, { key: '', labels: {}, builtIn: false }] } }));

  const save = async (scope: EvaluationScope) => {
    setSaving(scope);
    setError(null);
    setFlash(null);
    try {
      // A built-in row the admin never edited is sent with the dictionary
      // wording in every language — the moment a framework becomes the org's
      // own, its labels have to live in the org's own data.
      const criteria = state[scope].rows
        .filter((r) => r.key.trim())
        .map((r, i) => ({
          key: r.key.trim(),
          labels: r.builtIn && !Object.values(r.labels).some((v) => v?.trim())
            ? Object.fromEntries(locales.map((l) => [l, builtInLabel(r.key)]))
            : Object.fromEntries(
                Object.entries(r.labels)
                  .filter(([, v]) => v?.trim())
                  .map(([l, v]) => [l, v!.trim()])
              ),
          order: i,
        }));
      const res = await fetch('/api/admin/evaluation-templates', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, criteria }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.details?.formErrors?.[0] || data.error || 'Failed');
      setFlash(t.settings.saved);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setSaving(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.evaluationFramework.title}</CardTitle>
      </CardHeader>
      <p className="text-sm text-gray-500 mb-4">{t.evaluationFramework.subtitle}</p>
      {flash && <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">{flash}</div>}
      {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}

      <div className="space-y-8">
        {EVALUATION_SCOPES.map((scope) => (
          <section key={scope} data-testid={`framework-${scope}`}>
            <div className="flex items-baseline justify-between gap-2 mb-2">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {scope === 'MENTEE' ? t.evaluationFramework.onMentee : t.evaluationFramework.onMentor}
              </h3>
              <span className="text-xs text-gray-400">
                {state[scope].isCustom ? t.evaluationFramework.custom : t.evaluationFramework.builtIn}
              </span>
            </div>

            <div className="space-y-2">
              {state[scope].rows.map((row, i) => (
                <div key={i} className="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <input
                      value={row.key}
                      onChange={(e) => patchRow(scope, i, { key: e.target.value })}
                      placeholder={t.evaluationFramework.keyPlaceholder}
                      aria-label={t.evaluationFramework.key}
                      className="w-40 rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-2 py-1 text-sm font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => removeRow(scope, i)}
                      aria-label={t.evaluationFramework.remove}
                      title={t.evaluationFramework.remove}
                      className="ml-auto text-gray-300 hover:text-red-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    {locales.map((l) => (
                      <label key={l} className="text-xs text-gray-500">
                        {l.toUpperCase()}
                        <input
                          value={row.labels[l] ?? ''}
                          onChange={(e) => patchRow(scope, i, { labels: { ...row.labels, [l]: e.target.value } })}
                          placeholder={row.builtIn ? builtInLabel(row.key) : ''}
                          className="mt-0.5 block w-full rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-2 py-1 text-sm"
                        />
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-3 flex items-center gap-2">
              <Button type="button" size="sm" variant="secondary" onClick={() => addRow(scope)}>
                <Plus className="h-4 w-4" />
                {t.evaluationFramework.add}
              </Button>
              <Button
                type="button"
                size="sm"
                loading={saving === scope}
                onClick={() => save(scope)}
                data-testid={`framework-save-${scope}`}
              >
                {t.common.save}
              </Button>
            </div>
            <p className="mt-2 text-xs text-gray-500">{t.evaluationFramework.retireHint}</p>
          </section>
        ))}
      </div>
    </Card>
  );
}
