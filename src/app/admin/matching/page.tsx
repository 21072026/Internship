'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Archive, Plus, Trash2 } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { MatchScoreBreakdown } from '@/components/matching/MatchScoreBreakdown';
import { useT } from '@/i18n/client';
import { MATCH_DIMENSIONS, type MatchRuleKind } from '@/lib/matching/types';
import { normalizedWeights, type SimulatedMentee, type SimulationSummary } from '@/lib/matching/simulate';
import type { MatchRuleDraft } from '@/lib/matching/ruleSetSchema';

// /admin/matching (#1783): the org's matching rule sets — weights, hard rules,
// per-dimension settings — and a dry run of the draft on screen. Nothing on
// this page can create a pairing: the simulation is read-only by definition,
// and saving a set only changes how suggestions are ranked.

interface RuleSet {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  version: number;
  rules: MatchRuleDraft[];
}

interface Draft {
  id: string | null;
  name: string;
  description: string;
  rules: MatchRuleDraft[];
}

const KINDS: MatchRuleKind[] = ['WEIGHTED', 'HARD_REQUIRE', 'HARD_EXCLUDE'];

export default function MatchingRulesPage() {
  const t = useT();
  const L = t.adminMatching;
  const dims = t.matchScore.dimensions as Record<string, string>;
  const kinds = t.matchScore.kinds as Record<string, string>;

  const [sets, setSets] = useState<RuleSet[]>([]);
  const [builtIn, setBuiltIn] = useState<MatchRuleDraft[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [archiving, setArchiving] = useState(false);
  const [cohorts, setCohorts] = useState<{ id: string; name: string }[]>([]);
  const [scope, setScope] = useState('unmatched');
  const [sim, setSim] = useState<{ results: SimulatedMentee[]; summary: SimulationSummary; truncated: boolean } | null>(null);
  const [simBusy, setSimBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/matching/rule-sets');
    if (!res.ok) return;
    const d = await res.json();
    setSets(d.ruleSets ?? []);
    setBuiltIn((d.builtIn?.rules ?? []).map((r: MatchRuleDraft) => ({ ...r, config: { ...(r.config ?? {}) } })));
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    fetch('/api/cohorts')
      .then((r) => (r.ok ? r.json() : { cohorts: [] }))
      .then((d) => setCohorts((d.cohorts ?? []).map((c: { id: string; name: string }) => ({ id: c.id, name: c.name }))))
      .catch(() => {});
  }, []);

  const open = (s: RuleSet | null) => {
    setMsg('');
    setSim(null);
    setDraft(
      s
        ? { id: s.id, name: s.name, description: s.description ?? '', rules: s.rules.map((r) => ({ ...r, config: { ...r.config } })) }
        : { id: null, name: '', description: '', rules: builtIn.map((r) => ({ ...r, config: { ...r.config } })) }
    );
  };

  const shares = useMemo(() => (draft ? normalizedWeights(draft.rules) : []), [draft]);
  const defaultSet = sets.find((s) => s.isDefault);

  const patchRule = (i: number, patch: Partial<MatchRuleDraft>) =>
    setDraft((d) => (d ? { ...d, rules: d.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) } : d));
  const patchConfig = (i: number, key: string, value: unknown) =>
    setDraft((d) => {
      if (!d) return d;
      return {
        ...d,
        rules: d.rules.map((r, j) => {
          if (j !== i) return r;
          const config: Record<string, unknown> = { ...r.config };
          if (value === undefined || value === '' || value === false) delete config[key];
          else config[key] = value;
          return { ...r, config };
        }),
      };
    });

  const body = (d: Draft) => ({ name: d.name.trim(), description: d.description.trim() || null, rules: d.rules });

  const save = async (makeDefault: boolean) => {
    if (!draft) return;
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch('/api/admin/matching/rule-sets', {
        method: draft.id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(draft.id ? { id: draft.id } : {}), ...body(draft), ...(makeDefault ? { isDefault: true } : {}) }),
      });
      if (!res.ok) {
        setMsg(t.common.error);
        return;
      }
      const d = await res.json();
      setDraft((cur) => (cur ? { ...cur, id: d.ruleSet.id } : cur));
      setMsg(L.saved);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    if (!draft?.id) return;
    setArchiving(false);
    const res = await fetch(`/api/admin/matching/rule-sets/${draft.id}`, { method: 'DELETE' });
    if (res.ok) {
      setDraft(null);
      await load();
    } else setMsg(t.common.error);
  };

  const simulate = async () => {
    if (!draft) return;
    setSimBusy(true);
    try {
      const res = await fetch('/api/admin/matching/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ruleSet: { ...body(draft), name: draft.name.trim() || 'draft' },
          ...(scope === 'unmatched' ? { unmatched: true } : { cohortId: scope }),
        }),
      });
      setSim(res.ok ? await res.json() : null);
      if (!res.ok) setMsg(t.common.error);
    } finally {
      setSimBusy(false);
    }
  };

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{L.title}</h1>
          <p className="text-gray-500 mt-1 max-w-3xl">{L.intro}</p>
        </div>
        {/* The bulk rounds (#1796) are scored by these rules. */}
        <Link href="/admin/matching/rounds" className="text-sm font-medium text-blue-700 hover:underline" data-testid="matching-rounds-link">
          {t.matchRounds.roundsLink}
        </Link>
      </div>

      <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
        <Card padding="sm">
          {!defaultSet && <p className="mb-3 text-xs text-gray-500" data-testid="matching-builtin-note">{L.builtIn}</p>}
          <ul className="space-y-1" data-testid="matching-rule-sets">
            {sets.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => open(s)}
                  data-testid={`matching-set-${s.id}`}
                  aria-pressed={draft?.id === s.id}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm ${
                    draft?.id === s.id ? 'bg-blue-50 text-blue-700' : 'hover:bg-gray-50 dark:hover:bg-gray-800'
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  <span className="text-xs text-gray-400">{L.versionLabel.replace('{n}', String(s.version))}</span>
                  {s.isDefault && <Badge variant="success">{L.defaultBadge}</Badge>}
                </button>
              </li>
            ))}
          </ul>
          <Button size="sm" variant="outline" className="mt-3 w-full" onClick={() => open(null)} data-testid="matching-new-set">
            <Plus className="h-4 w-4" /> {L.newSet}
          </Button>
        </Card>

        {draft && (
          <div className="space-y-6 min-w-0">
            <Card>
              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  label={L.name}
                  value={draft.name}
                  maxLength={191}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  data-testid="matching-name"
                />
                <Input
                  label={L.description}
                  value={draft.description}
                  maxLength={2000}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                />
              </div>

              <p className="mt-5 mb-2 text-sm font-semibold text-gray-700 dark:text-gray-300">{L.rules}</p>
              {draft.rules.length === 0 && <p className="text-sm text-gray-500">{L.noRulesYet}</p>}
              <ul className="space-y-2" data-testid="matching-rules">
                {draft.rules.map((r, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 p-2.5 dark:border-gray-700" data-testid={`matching-rule-${i}`}>
                    <select
                      aria-label={L.dimension}
                      value={r.dimension}
                      onChange={(e) => patchRule(i, { dimension: e.target.value as MatchRuleDraft['dimension'], config: {} })}
                      className="rounded-lg border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-800"
                    >
                      {MATCH_DIMENSIONS.map((d) => (
                        <option key={d} value={d}>{dims[d] ?? d}</option>
                      ))}
                    </select>
                    <select
                      aria-label={L.kind}
                      value={r.kind}
                      onChange={(e) => patchRule(i, { kind: e.target.value as MatchRuleKind })}
                      className="rounded-lg border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-800"
                      data-testid={`matching-rule-kind-${i}`}
                    >
                      {KINDS.map((k) => (
                        <option key={k} value={k}>{kinds[k] ?? k}</option>
                      ))}
                    </select>
                    {r.kind === 'WEIGHTED' && (
                      <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                        {L.weight}
                        <input
                          type="range"
                          min={0}
                          max={100}
                          value={r.weight}
                          onChange={(e) => patchRule(i, { weight: Number(e.target.value) })}
                          data-testid={`matching-rule-weight-${i}`}
                        />
                        <span className="w-24 tabular-nums" data-testid={`matching-rule-share-${i}`}>
                          {L.share.replace('{n}', String(shares[i] ?? 0))}
                        </span>
                      </label>
                    )}
                    {r.dimension === 'timezone' && (
                      <label className="flex items-center gap-1 text-xs text-gray-600">
                        {L.maxHours}
                        <input
                          type="number"
                          min={0}
                          max={14}
                          value={typeof r.config.maxHours === 'number' ? r.config.maxHours : ''}
                          placeholder="3"
                          onChange={(e) => patchConfig(i, 'maxHours', e.target.value === '' ? undefined : Number(e.target.value))}
                          className="w-16 rounded border border-gray-300 px-1.5 py-0.5 dark:border-gray-700 dark:bg-gray-800"
                        />
                      </label>
                    )}
                    {r.dimension === 'skills' && (
                      <label className="flex items-center gap-1 text-xs text-gray-600">
                        {L.minShared}
                        <input
                          type="number"
                          min={1}
                          max={40}
                          value={typeof r.config.minShared === 'number' ? r.config.minShared : ''}
                          placeholder="1"
                          onChange={(e) => patchConfig(i, 'minShared', e.target.value === '' ? undefined : Number(e.target.value))}
                          className="w-16 rounded border border-gray-300 px-1.5 py-0.5 dark:border-gray-700 dark:bg-gray-800"
                        />
                      </label>
                    )}
                    {r.dimension === 'capacityHeadroom' && (
                      <label className="flex items-center gap-1 text-xs text-gray-600">
                        <input
                          type="checkbox"
                          checked={r.config.honourPreference === true}
                          onChange={(e) => patchConfig(i, 'honourPreference', e.target.checked)}
                        />
                        {L.honourPreference}
                      </label>
                    )}
                    {r.dimension === 'capacityHeadroom' && (
                      <label className="flex items-center gap-1 text-xs text-gray-600">
                        <input
                          type="checkbox"
                          checked={r.config.selfSelect === true}
                          onChange={(e) => patchConfig(i, 'selfSelect', e.target.checked)}
                        />
                        {L.selfSelectRound}
                      </label>
                    )}
                    <button
                      type="button"
                      onClick={() => setDraft({ ...draft, rules: draft.rules.filter((_, j) => j !== i) })}
                      aria-label={L.removeRule}
                      title={L.removeRule}
                      className="ml-auto rounded p-1 text-gray-400 hover:text-red-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={draft.rules.length >= 20}
                  onClick={() => setDraft({ ...draft, rules: [...draft.rules, { dimension: 'skills', kind: 'WEIGHTED', weight: 50, config: {} }] })}
                  data-testid="matching-add-rule"
                >
                  <Plus className="h-4 w-4" /> {L.addRule}
                </Button>
                <span className="flex-1" />
                {msg && <span className="text-sm text-gray-600" data-testid="matching-msg">{msg}</span>}
                {draft.id && (
                  <Button size="sm" variant="ghost" onClick={() => setArchiving(true)} data-testid="matching-archive">
                    <Archive className="h-4 w-4" /> {L.archive}
                  </Button>
                )}
                <Button size="sm" variant="outline" loading={busy} disabled={!draft.name.trim()} onClick={() => save(false)} data-testid="matching-save">
                  {L.save}
                </Button>
                <Button size="sm" loading={busy} disabled={!draft.name.trim()} onClick={() => save(true)} data-testid="matching-save-default">
                  {L.makeDefault}
                </Button>
              </div>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{L.simulateTitle}</CardTitle>
                <CardDescription>{L.simulateHint}</CardDescription>
              </CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                  aria-label={L.simulateTitle}
                  className="min-w-0 max-w-full rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800"
                  data-testid="matching-sim-scope"
                >
                  <option value="unmatched">{L.scopeUnmatched}</option>
                  {cohorts.map((c) => (
                    <option key={c.id} value={c.id}>{L.scopeCohort.replace('{name}', c.name)}</option>
                  ))}
                </select>
                <Button size="sm" loading={simBusy} onClick={simulate} data-testid="matching-simulate">
                  {L.run}
                </Button>
              </div>

              {sim && (
                <div className="mt-4" data-testid="matching-sim-result">
                  <ul className="mb-3 space-y-0.5 text-sm text-gray-700 dark:text-gray-300" data-testid="matching-sim-summary">
                    <li>{L.coverage.replace('{x}', String(sim.summary.withEligible)).replace('{y}', String(sim.summary.mentees))}</li>
                    <li>{L.atCapacity.replace('{n}', String(sim.summary.mentorsAtCapacity)).replace('{m}', String(sim.summary.mentors))}</li>
                    {sim.summary.mostEliminating && (
                      <li data-testid="matching-sim-most-eliminating">
                        {L.mostEliminating
                          .replace('{rule}', dims[sim.summary.mostEliminating.dimension] ?? sim.summary.mostEliminating.dimension)
                          .replace('{n}', String(sim.summary.mostEliminating.count))}
                      </li>
                    )}
                  </ul>
                  {sim.truncated && <p className="mb-2 text-xs text-gray-500">{L.truncated}</p>}
                  {sim.results.length === 0 && <p className="text-sm text-gray-500">{L.noMentees}</p>}
                  <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                    {sim.results.map((m) => (
                      <li key={m.menteeId} className="py-2" data-testid={`matching-sim-mentee-${m.menteeId}`}>
                        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{m.fullName}</p>
                        {m.top.length === 0 ? (
                          <p className="text-xs text-red-700">
                            {L.noneEligible.replace('{rule}', m.mostEliminating ? (dims[m.mostEliminating.dimension] ?? m.mostEliminating.dimension) : '—')}
                          </p>
                        ) : (
                          <ol className="mt-1 space-y-0.5">
                            {m.top.map((c) => (
                              <li key={c.mentorId} className="flex min-w-0 items-center gap-2 text-xs" data-testid={`matching-sim-candidate-${c.mentorId}`}>
                                <span className="shrink-0 text-gray-700 dark:text-gray-300">{c.fullName}</span>
                                <MatchScoreBreakdown compact {...c.match} />
                              </li>
                            ))}
                          </ol>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Card>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={archiving}
        message={L.archiveConfirm}
        cancelLabel={t.common.cancel}
        confirmLabel={L.archive}
        onConfirm={archive}
        onCancel={() => setArchiving(false)}
      />
    </div>
  );
}
