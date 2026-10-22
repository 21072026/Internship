'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, GitMerge, Link2, Loader2, Pencil, Plus, X } from 'lucide-react';
import { useT } from '@/i18n/client';

interface Edge {
  id: string;
  skillId: string;
  label: string;
  weight: number;
  kind: string;
}

interface SkillRow {
  id: string;
  key: string;
  labelEn: string;
  labelTr: string;
  labelDe: string;
  category: string | null;
  status: string;
  mergedIntoId: string | null;
  mergedIntoLabel: string | null;
  usageUsers: number;
  usageRequisitions: number;
  aliases: { id: string; key: string }[];
  edges: Edge[];
}

interface QueueTerm {
  id: string;
  term: string;
  occurrences: number;
}

type Panel = { id: string; kind: 'edit' | 'merge' | 'alias' | 'edges' } | null;

const STATUS_FILTERS = ['ACTIVE', 'RETIRED', 'MERGED', 'ALL'] as const;

/** `{slot}` substitution for plain-text copy (counts, names). */
function fmt(template: string, slots: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => slots[key] ?? whole);
}

/**
 * /admin/skills (#1817): the org's canonical skill vocabulary, as something an
 * admin can repair — relabel in three languages, add spellings, merge two
 * skills that are one, retire one nobody should pick any more, and say which
 * skills are neighbours. The second tab is the backfill's review queue (#1819):
 * free-text terms nothing resolved, to promote, alias or discard.
 *
 * Every rule lives on the server (`src/lib/skillCuration.ts`); this screen only
 * asks, and states what a merge will move before it is confirmed.
 */
export function SkillManager() {
  const t = useT();
  const m = t.skillAdmin;
  const [tab, setTab] = useState<'vocabulary' | 'queue'>('vocabulary');

  return (
    <div>
      <div role="tablist" aria-label={m.title} className="mb-4 flex gap-1 border-b border-gray-200 dark:border-gray-800">
        {(['vocabulary', 'queue'] as const).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            data-testid={`skill-admin-tab-${key}`}
            onClick={() => setTab(key)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${
              tab === key
                ? 'border-blue-600 text-blue-700 dark:text-blue-300'
                : 'border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'
            }`}
          >
            {key === 'vocabulary' ? m.tabVocabulary : m.tabQueue}
          </button>
        ))}
      </div>
      {tab === 'vocabulary' ? <Vocabulary /> : <Queue />}
    </div>
  );
}

function errorText(m: ReturnType<typeof useT>['skillAdmin'], code: string | undefined): string {
  switch (code) {
    case 'duplicate':
      return m.errorDuplicate;
    case 'org_limit':
      return m.errorLimit;
    case 'invalid_label':
    case 'invalid_alias':
      return m.errorLabel;
    default:
      return m.errorGeneric;
  }
}

function Vocabulary() {
  const t = useT();
  const m = t.skillAdmin;
  const [rows, setRows] = useState<SkillRow[]>([]);
  const [total, setTotal] = useState(0);
  const [orgTotal, setOrgTotal] = useState(0);
  const [limit, setLimit] = useState(0);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>('ACTIVE');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>(null);

  const [draft, setDraft] = useState({ labelEn: '', labelTr: '', labelDe: '', category: '' });
  const [newLabel, setNewLabel] = useState('');
  const [aliasDraft, setAliasDraft] = useState('');
  const [mergeTarget, setMergeTarget] = useState('');
  const [mergeInfo, setMergeInfo] = useState<{ users: number; requisitions: number; alreadyBoth: number } | null>(null);
  const [edgeDraft, setEdgeDraft] = useState<{ skillId: string; label: string; weight: number }[]>([]);
  const [edgeAdd, setEdgeAdd] = useState('');
  const [allActive, setAllActive] = useState<{ id: string; labelEn: string }[]>([]);

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ q, status });
    fetch(`/api/admin/skills?${params}`)
      .then((r) => (r.ok ? r.json() : { skills: [], total: 0 }))
      .then((d) => {
        setRows(d.skills ?? []);
        setTotal(d.total ?? 0);
        setOrgTotal(d.orgTotal ?? 0);
        setLimit(d.limit ?? 0);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [q, status]);

  useEffect(() => {
    const timer = setTimeout(load, 200);
    return () => clearTimeout(timer);
  }, [load]);

  // The merge target and the neighbour picker choose among live skills.
  const loadActive = useCallback(() => {
    fetch('/api/admin/skills?status=ACTIVE')
      .then((r) => (r.ok ? r.json() : { skills: [] }))
      .then((d) => setAllActive((d.skills ?? []).map((s: SkillRow) => ({ id: s.id, labelEn: s.labelEn }))))
      .catch(() => {});
  }, []);

  const call = async (id: string, url: string, init: RequestInit) => {
    setBusy(id);
    setError('');
    try {
      const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(errorText(m, body?.code));
        return null;
      }
      load();
      return body;
    } finally {
      setBusy(null);
    }
  };

  const open = (row: SkillRow, kind: NonNullable<Panel>['kind']) => {
    if (panel?.id === row.id && panel.kind === kind) return setPanel(null);
    setPanel({ id: row.id, kind });
    setError('');
    if (kind === 'edit') setDraft({ labelEn: row.labelEn, labelTr: row.labelTr, labelDe: row.labelDe, category: row.category ?? '' });
    if (kind === 'alias') setAliasDraft('');
    if (kind === 'merge') {
      setMergeTarget('');
      setMergeInfo(null);
      loadActive();
    }
    if (kind === 'edges') {
      setEdgeDraft(row.edges.map((e) => ({ skillId: e.skillId, label: e.label, weight: e.weight })));
      setEdgeAdd('');
      loadActive();
    }
  };

  const pickMergeTarget = async (row: SkillRow, targetId: string) => {
    setMergeTarget(targetId);
    setMergeInfo(null);
    if (!targetId) return;
    const res = await fetch(`/api/admin/skills/${row.id}/merge?targetId=${encodeURIComponent(targetId)}`);
    if (res.ok) setMergeInfo(await res.json());
  };

  const create = async () => {
    if (!newLabel.trim()) return;
    const ok = await call('new', '/api/admin/skills', { method: 'POST', body: JSON.stringify({ labelEn: newLabel }) });
    if (ok) setNewLabel('');
  };

  const counter = fmt(m.count, { n: String(orgTotal), max: String(limit) });

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={m.search}
          aria-label={m.search}
          data-testid="skill-admin-search"
          className="w-full sm:w-64 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as (typeof STATUS_FILTERS)[number])}
          aria-label={m.statusFilter}
          data-testid="skill-admin-status"
          className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
        >
          {STATUS_FILTERS.map((s) => (
            <option key={s} value={s}>
              {m[`status${s}` as const]}
            </option>
          ))}
        </select>
        {/* Full width at phone width: the fixed input + button were ~350px in a
            328px box (e2e/mobile-layout-coverage.spec.ts); sm+ keeps the row. */}
        <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
          <input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
            placeholder={m.createPlaceholder}
            aria-label={m.createPlaceholder}
            data-testid="skill-admin-new"
            className="min-w-0 flex-1 sm:w-56 sm:flex-none rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={create}
            disabled={busy === 'new' || !newLabel.trim()}
            data-testid="skill-admin-create"
            className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
          >
            <Plus className="h-4 w-4" /> {m.create}
          </button>
        </div>
      </div>

      <p className="mb-3 text-xs text-gray-500 dark:text-gray-400" data-testid="skill-admin-count">
        {counter} · {fmt(m.showing, { n: String(total) })}
      </p>
      {error && (
        <p data-testid="skill-admin-error" className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

      {loading && rows.length === 0 ? (
        <p className="text-sm text-gray-400">{m.loading}</p>
      ) : rows.length === 0 ? (
        <p data-testid="skill-admin-empty" className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-10 text-center text-gray-500">
          {m.none}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
          <table className="w-full text-sm" data-testid="skill-admin-table">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-800 text-left text-gray-500 dark:text-gray-400">
                <th className="px-4 py-3 font-medium">{m.colSkill}</th>
                <th className="px-4 py-3 font-medium">{m.colAliases}</th>
                <th className="px-4 py-3 font-medium">{m.colNeighbours}</th>
                <th className="px-4 py-3 font-medium">{m.colUsage}</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const merged = !!row.mergedIntoId;
                return (
                  <tr key={row.id} data-testid={`skill-row-${row.key}`} className="border-b border-gray-100 dark:border-gray-800/60 last:border-0 align-top">
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900 dark:text-gray-100">{row.labelEn}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {row.labelTr} · {row.labelDe}
                        {row.category ? ` · ${row.category}` : ''}
                      </div>
                      {merged ? (
                        <span data-testid="skill-merged-badge" className="mt-1 inline-block rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                          {fmt(m.mergedInto, { name: row.mergedIntoLabel ?? '' })}
                        </span>
                      ) : row.status === 'RETIRED' ? (
                        <span data-testid="skill-retired-badge" className="mt-1 inline-block rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                          {m.retired}
                        </span>
                      ) : null}

                      {panel?.id === row.id && panel.kind === 'edit' && (
                        <div className="mt-2 grid max-w-md gap-2" data-testid="skill-edit-panel">
                          {(['labelEn', 'labelTr', 'labelDe'] as const).map((field) => (
                            <label key={field} className="text-xs text-gray-600 dark:text-gray-300">
                              {m[field]}
                              <input
                                value={draft[field]}
                                onChange={(e) => setDraft({ ...draft, [field]: e.target.value })}
                                data-testid={`skill-edit-${field}`}
                                className="mt-0.5 block w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1 text-sm"
                              />
                            </label>
                          ))}
                          <label className="text-xs text-gray-600 dark:text-gray-300">
                            {m.category}
                            <input
                              value={draft.category}
                              onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                              className="mt-0.5 block w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1 text-sm"
                            />
                          </label>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              data-testid="skill-edit-save"
                              onClick={async () => {
                                const ok = await call(row.id, `/api/admin/skills/${row.id}`, {
                                  method: 'PATCH',
                                  body: JSON.stringify({ ...draft, category: draft.category || null }),
                                });
                                if (ok) setPanel(null);
                              }}
                              className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
                            >
                              <Check className="h-3.5 w-3.5" /> {m.save}
                            </button>
                            <button type="button" onClick={() => setPanel(null)} className="rounded-lg px-3 py-1 text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800">
                              {m.cancel}
                            </button>
                          </div>
                        </div>
                      )}

                      {panel?.id === row.id && panel.kind === 'merge' && (
                        <div className="mt-2 max-w-md space-y-2" data-testid="skill-merge-panel">
                          <select
                            value={mergeTarget}
                            onChange={(e) => pickMergeTarget(row, e.target.value)}
                            data-testid="skill-merge-target"
                            aria-label={m.mergePick}
                            className="block w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1 text-sm"
                          >
                            <option value="">{m.mergePick}</option>
                            {allActive.filter((s) => s.id !== row.id).map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.labelEn}
                              </option>
                            ))}
                          </select>
                          {mergeInfo && (
                            <p data-testid="skill-merge-preview" className="text-xs text-gray-700 dark:text-gray-300">
                              {fmt(m.mergePreview, {
                                users: String(mergeInfo.users),
                                requisitions: String(mergeInfo.requisitions),
                                both: String(mergeInfo.alreadyBoth),
                                name: allActive.find((s) => s.id === mergeTarget)?.labelEn ?? '',
                              })}
                            </p>
                          )}
                          <button
                            type="button"
                            disabled={!mergeInfo || busy === row.id}
                            data-testid="skill-merge-confirm"
                            onClick={async () => {
                              const ok = await call(row.id, `/api/admin/skills/${row.id}/merge`, {
                                method: 'POST',
                                body: JSON.stringify({ targetId: mergeTarget }),
                              });
                              if (ok) setPanel(null);
                            }}
                            className="rounded-lg bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40"
                          >
                            {m.mergeConfirm}
                          </button>
                        </div>
                      )}
                    </td>

                    <td className="px-4 py-3">
                      <div className="flex max-w-xs flex-wrap gap-1">
                        {row.aliases.map((a) => (
                          <span key={a.id} data-testid="skill-alias-chip" className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                            {a.key}
                            {!merged && (
                              <button
                                type="button"
                                aria-label={`${m.removeAlias}: ${a.key}`}
                                onClick={() => call(row.id, `/api/admin/skills/${row.id}/aliases/${a.id}`, { method: 'DELETE' })}
                                className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-100"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            )}
                          </span>
                        ))}
                      </div>
                      {panel?.id === row.id && panel.kind === 'alias' && (
                        <div className="mt-2 flex gap-2">
                          <input
                            value={aliasDraft}
                            onChange={(e) => setAliasDraft(e.target.value)}
                            placeholder={m.aliasPlaceholder}
                            aria-label={m.aliasPlaceholder}
                            data-testid="skill-alias-input"
                            className="w-40 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1 text-sm"
                          />
                          <button
                            type="button"
                            data-testid="skill-alias-save"
                            onClick={async () => {
                              const ok = await call(row.id, `/api/admin/skills/${row.id}/aliases`, {
                                method: 'POST',
                                body: JSON.stringify({ alias: aliasDraft }),
                              });
                              if (ok) setAliasDraft('');
                            }}
                            className="rounded-lg bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
                          >
                            {m.addAlias}
                          </button>
                        </div>
                      )}
                    </td>

                    <td className="px-4 py-3">
                      {panel?.id === row.id && panel.kind === 'edges' ? (
                        <div className="max-w-sm space-y-2" data-testid="skill-edges-panel">
                          {edgeDraft.map((e, i) => (
                            <div key={e.skillId} className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
                              <span className="flex-1 truncate">{e.label}</span>
                              <input
                                type="number"
                                min={0}
                                max={1}
                                step={0.1}
                                value={e.weight}
                                aria-label={`${m.neighbourWeight}: ${e.label}`}
                                onChange={(ev) => {
                                  const next = [...edgeDraft];
                                  next[i] = { ...e, weight: Math.min(1, Math.max(0, Number(ev.target.value))) };
                                  setEdgeDraft(next);
                                }}
                                className="w-16 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-1 py-0.5"
                              />
                              <button
                                type="button"
                                aria-label={`${m.removeNeighbour}: ${e.label}`}
                                onClick={() => setEdgeDraft(edgeDraft.filter((x) => x.skillId !== e.skillId))}
                                className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-100"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </div>
                          ))}
                          <div className="flex gap-2">
                            <select
                              value={edgeAdd}
                              onChange={(e) => setEdgeAdd(e.target.value)}
                              aria-label={m.addNeighbour}
                              data-testid="skill-edge-add"
                              className="flex-1 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1 text-xs"
                            >
                              <option value="">{m.addNeighbour}</option>
                              {allActive
                                .filter((s) => s.id !== row.id && !edgeDraft.some((e) => e.skillId === s.id))
                                .map((s) => (
                                  <option key={s.id} value={s.id}>
                                    {s.labelEn}
                                  </option>
                                ))}
                            </select>
                            <button
                              type="button"
                              disabled={!edgeAdd}
                              data-testid="skill-edge-add-confirm"
                              onClick={() => {
                                const s = allActive.find((x) => x.id === edgeAdd);
                                if (s) setEdgeDraft([...edgeDraft, { skillId: s.id, label: s.labelEn, weight: 0.5 }]);
                                setEdgeAdd('');
                              }}
                              className="rounded-lg border border-gray-300 dark:border-gray-700 px-2 py-1 text-xs disabled:opacity-40"
                            >
                              <Plus className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          <button
                            type="button"
                            data-testid="skill-edges-save"
                            onClick={async () => {
                              const ok = await call(row.id, `/api/admin/skills/${row.id}/edges`, {
                                method: 'PUT',
                                body: JSON.stringify({ edges: edgeDraft.map((e) => ({ skillId: e.skillId, weight: e.weight })) }),
                              });
                              if (ok) setPanel(null);
                            }}
                            className="rounded-lg bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
                          >
                            {m.save}
                          </button>
                        </div>
                      ) : (
                        <div className="flex max-w-xs flex-wrap gap-1">
                          {row.edges.map((e) => (
                            <span key={e.id} className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                              {e.label} <span className="text-gray-400">{e.weight.toFixed(1)}</span>
                            </span>
                          ))}
                        </div>
                      )}
                    </td>

                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300" data-testid={`skill-usage-${row.key}`}>
                      {fmt(m.usage, { users: String(row.usageUsers), requisitions: String(row.usageRequisitions) })}
                    </td>

                    <td className="px-4 py-3">
                      {!merged && (
                        <div className="flex justify-end gap-1">
                          {busy === row.id && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
                          <button type="button" onClick={() => open(row, 'edit')} data-testid={`skill-edit-${row.key}`} aria-label={m.edit} title={m.edit} className="rounded p-1.5 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800">
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button type="button" onClick={() => open(row, 'alias')} data-testid={`skill-alias-${row.key}`} aria-label={m.addAlias} title={m.addAlias} className="rounded p-1.5 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800">
                            <Plus className="h-4 w-4" />
                          </button>
                          <button type="button" onClick={() => open(row, 'edges')} data-testid={`skill-edges-${row.key}`} aria-label={m.neighbours} title={m.neighbours} className="rounded p-1.5 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800">
                            <Link2 className="h-4 w-4" />
                          </button>
                          <button type="button" onClick={() => open(row, 'merge')} data-testid={`skill-merge-${row.key}`} aria-label={m.merge} title={m.merge} className="rounded p-1.5 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800">
                            <GitMerge className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            data-testid={`skill-status-${row.key}`}
                            onClick={() =>
                              call(row.id, `/api/admin/skills/${row.id}`, {
                                method: 'PATCH',
                                body: JSON.stringify({ status: row.status === 'RETIRED' ? 'ACTIVE' : 'RETIRED' }),
                              })
                            }
                            className="rounded px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
                          >
                            {row.status === 'RETIRED' ? m.reactivate : m.retire}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Queue() {
  const t = useT();
  const m = t.skillAdmin;
  const [terms, setTerms] = useState<QueueTerm[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [aliasFor, setAliasFor] = useState<string | null>(null);
  const [aliasTarget, setAliasTarget] = useState('');
  const [skills, setSkills] = useState<{ id: string; labelEn: string }[]>([]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    fetch('/api/admin/skills/unmapped')
      .then((r) => (r.ok ? r.json() : { terms: [] }))
      .then((d) => setTerms(d.terms ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  const decide = async (term: QueueTerm, body: Record<string, string>) => {
    setBusy(term.id);
    setError('');
    setNotice('');
    try {
      const res = await fetch(`/api/admin/skills/unmapped/${term.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return setError(errorText(m, data?.code));
      setAliasFor(null);
      setNotice(fmt(m.queueDone, { term: term.term, n: String(data.linkedUsers ?? 0) }));
      load();
    } finally {
      setBusy(null);
    }
  };

  const openAlias = (term: QueueTerm) => {
    setAliasFor(aliasFor === term.id ? null : term.id);
    setAliasTarget('');
    if (skills.length === 0) {
      fetch('/api/admin/skills?status=ACTIVE')
        .then((r) => (r.ok ? r.json() : { skills: [] }))
        .then((d) => setSkills((d.skills ?? []).map((s: SkillRow) => ({ id: s.id, labelEn: s.labelEn }))))
        .catch(() => {});
    }
  };

  if (loading && terms.length === 0) return <p className="text-sm text-gray-400">{m.loading}</p>;

  return (
    <div>
      <p className="mb-3 max-w-3xl text-sm text-gray-500 dark:text-gray-400">{m.queueHint}</p>
      {notice && <p data-testid="skill-queue-notice" className="mb-3 text-sm text-green-700 dark:text-green-300">{notice}</p>}
      {error && <p data-testid="skill-queue-error" className="mb-3 text-sm text-red-700 dark:text-red-300">{error}</p>}
      {terms.length === 0 ? (
        <p data-testid="skill-queue-empty" className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-10 text-center text-gray-500">
          {m.queueNone}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
          <table className="w-full text-sm" data-testid="skill-queue-table">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-800 text-left text-gray-500 dark:text-gray-400">
                <th className="px-4 py-3 font-medium">{m.colTerm}</th>
                <th className="px-4 py-3 font-medium">{m.colOccurrences}</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {terms.map((term) => (
                <tr key={term.id} data-testid="skill-queue-row" className="border-b border-gray-100 dark:border-gray-800/60 last:border-0 align-top">
                  <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100">
                    {term.term}
                    {aliasFor === term.id && (
                      <div className="mt-2 flex max-w-sm gap-2">
                        <select
                          value={aliasTarget}
                          onChange={(e) => setAliasTarget(e.target.value)}
                          aria-label={m.aliasPick}
                          data-testid="skill-queue-alias-target"
                          className="flex-1 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1 text-xs font-normal"
                        >
                          <option value="">{m.aliasPick}</option>
                          {skills.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.labelEn}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          disabled={!aliasTarget || busy === term.id}
                          data-testid="skill-queue-alias-confirm"
                          onClick={() => decide(term, { action: 'alias', skillId: aliasTarget })}
                          className="rounded-lg bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40"
                        >
                          {m.alias}
                        </button>
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{term.occurrences}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1.5">
                      {busy === term.id && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
                      <button type="button" data-testid="skill-queue-promote" onClick={() => decide(term, { action: 'promote' })} className="rounded-lg border border-gray-300 dark:border-gray-700 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800">
                        {m.promote}
                      </button>
                      <button type="button" data-testid="skill-queue-alias" onClick={() => openAlias(term)} className="rounded-lg border border-gray-300 dark:border-gray-700 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800">
                        {m.alias}
                      </button>
                      <button type="button" data-testid="skill-queue-discard" onClick={() => decide(term, { action: 'discard' })} className="rounded-lg px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950/40">
                        {m.discard}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
