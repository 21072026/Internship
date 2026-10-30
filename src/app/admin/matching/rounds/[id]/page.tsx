'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Lock, Play, RotateCcw, Send, Shuffle, Trash2, Unlock } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { MatchScoreBreakdown } from '@/components/matching/MatchScoreBreakdown';
import { useT } from '@/i18n/client';
import type { MatchScore } from '@/lib/matching/types';
import type { RoundDiagnostics } from '@/lib/matching/roundDiagnostics';

// /admin/matching/rounds/[id] (#1796): the round board. Every proposal with
// its score and reasons; swap a mentor (scored on the server — the browser
// never sends a score), lock, unlock, discard and restore per row or for all
// visible rows; publish the locked set after a confirmation that says how many
// mentorships it creates and that both sides are e-mailed. The unmatched panel
// answers "why did these people get nobody?". Publishing is the only action
// here that pairs anybody, and it is always a person's click.

type RoundStatus = 'DRAFT' | 'REVIEW' | 'PUBLISHED' | 'DISCARDED';
type ProposalState = 'DRAFT' | 'LOCKED' | 'DISCARDED' | 'PUBLISHED';
type Action = 'lock' | 'unlock' | 'discard' | 'restore';
type Filter = 'all' | ProposalState | 'unmatched';

interface Alternative extends MatchScore {
  mentorId: string;
  headroomLeft: number | null;
}
interface Proposal {
  id: string;
  menteeId: string;
  mentorId: string | null;
  score: number | null;
  breakdown: MatchScore['breakdown'];
  blockedBy: string[];
  alternatives: Alternative[];
  state: ProposalState;
  unmatchedReason: string | null;
}
interface Round {
  id: string;
  name: string;
  status: RoundStatus;
  cohort: { id: string; name: string } | null;
  stats: { proposed?: number; unmatched?: Record<string, number>; mentorsUsed?: number; mentorsAtCapacity?: number; durationMs?: number };
  proposals: Proposal[];
}

const STATUS_VARIANT = { DRAFT: 'default', REVIEW: 'info', PUBLISHED: 'success', DISCARDED: 'warning' } as const;
const STATE_VARIANT = { DRAFT: 'default', LOCKED: 'info', DISCARDED: 'warning', PUBLISHED: 'success' } as const;
const FILTERS: Filter[] = ['all', 'DRAFT', 'LOCKED', 'DISCARDED', 'PUBLISHED', 'unmatched'];
const ACTIONS_FOR: Record<ProposalState, Action[]> = { DRAFT: ['lock', 'discard'], LOCKED: ['unlock', 'discard'], DISCARDED: ['restore'], PUBLISHED: [] };
const ACTION_ICON = { lock: Lock, unlock: Unlock, discard: Trash2, restore: RotateCcw } as const;

const fill = (template: string, vars: Record<string, string | number | null | undefined>) =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] != null ? String(vars[k]) : m));

export default function MatchRoundBoardPage() {
  const t = useT();
  const L = t.matchRounds;
  const dims = t.matchScore.dimensions as Record<string, string>;
  const ruleName = (r: string) => dims[r] ?? r;
  const { id } = useParams<{ id: string }>();

  const [round, setRound] = useState<Round | null>(null);
  const [people, setPeople] = useState<Record<string, string>>({});
  const [pool, setPool] = useState<{ id: string; fullName: string }[]>([]);
  const [diag, setDiag] = useState<RoundDiagnostics | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [swapFor, setSwapFor] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [confirm, setConfirm] = useState<'publish' | 'discard' | null>(null);

  const load = useCallback(async () => {
    const [res, d] = await Promise.all([fetch(`/api/admin/match-rounds/${id}`), fetch(`/api/admin/match-rounds/${id}/diagnostics`)]);
    if (res.ok) {
      const body = await res.json();
      setRound(body.round);
      setPeople(body.people ?? {});
      setPool(body.pool ?? []);
    }
    if (d.ok) setDiag((await d.json()).diagnostics);
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const name = (uid: string | null) => (uid ? people[uid] ?? pool.find((p) => p.id === uid)?.fullName ?? '—' : '—');
  const errorText = (body: Record<string, unknown> | null) => {
    const code = typeof body?.code === 'string' ? body.code : '';
    const template = (L.errors as Record<string, string>)[code] ?? L.errors.generic;
    const rules = Array.isArray(body?.blockedBy) ? (body!.blockedBy as string[]).map(ruleName).join(', ') : '';
    return fill(template, { ...(body as Record<string, string | number>), rules });
  };

  const call = async (url: string, init: RequestInit, after?: (body: Record<string, unknown>) => void) => {
    setBusy(true);
    setMsg('');
    const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init });
    const body = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      setMsg(errorText(body));
      return false;
    }
    after?.(body);
    await load();
    return true;
  };

  const editable = round?.status === 'DRAFT' || round?.status === 'REVIEW';
  const visible = useMemo(() => {
    const list = round?.proposals ?? [];
    if (filter === 'all') return list;
    if (filter === 'unmatched') return list.filter((p) => p.mentorId === null);
    return list.filter((p) => p.state === filter);
  }, [round, filter]);
  const lockedCount = (round?.proposals ?? []).filter((p) => p.state === 'LOCKED').length;

  const act = (action: Action, ids: string[]) =>
    call(`/api/admin/match-rounds/${id}/proposals`, { method: 'PATCH', body: JSON.stringify({ action, ids }) }, (b) => {
      const skipped = Array.isArray(b.skipped) ? b.skipped.length : 0;
      if (skipped) setMsg(fill(L.skipped, { n: skipped }));
      setSelected(new Set());
    });
  const swap = (proposalId: string, mentorId: string) =>
    call(`/api/admin/match-rounds/${id}/proposals`, { method: 'PATCH', body: JSON.stringify({ action: 'swap', id: proposalId, mentorId }) }, () => {
      setSwapFor(null);
      setSearch('');
    });

  if (!round) return null;
  const stats = round.stats ?? {};
  const unmatchedTotal = Object.values(stats.unmatched ?? {}).reduce((a, n) => a + (n ?? 0), 0);
  const searchHits = search.trim()
    ? pool.filter((m) => m.fullName.toLowerCase().includes(search.trim().toLowerCase())).slice(0, 10)
    : [];

  return (
    <div className="space-y-6">
      <Link href="/admin/matching/rounds" className="inline-flex items-center gap-1 text-sm font-medium text-blue-700 hover:underline">
        <ArrowLeft className="h-4 w-4" aria-hidden />
        {L.back}
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold" data-testid="round-title">{round.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-gray-600">
            <Badge variant={STATUS_VARIANT[round.status]} data-testid="round-status">{L.statuses[round.status]}</Badge>
            {round.cohort && <span>{round.cohort.name}</span>}
          </div>
        </div>
        {editable && (
          <div className="flex flex-wrap gap-2">
            {round.status === 'DRAFT' && (
              <>
                <Button data-testid="round-run" onClick={() => call(`/api/admin/match-rounds/${id}/run`, { method: 'POST' })} loading={busy}>
                  <Play className="mr-1 h-4 w-4" aria-hidden />
                  {round.proposals.length ? L.rerun : L.run}
                </Button>
                {round.proposals.length > 0 && (
                  <Button variant="secondary" data-testid="round-to-review" disabled={busy} onClick={() => call(`/api/admin/match-rounds/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'REVIEW' }) })}>
                    {L.toReview}
                  </Button>
                )}
              </>
            )}
            {round.status === 'REVIEW' && (
              <>
                <Button data-testid="round-publish" disabled={busy || lockedCount === 0} onClick={() => setConfirm('publish')}>
                  <Send className="mr-1 h-4 w-4" aria-hidden />
                  {L.publish}
                </Button>
                <Button variant="secondary" disabled={busy} onClick={() => call(`/api/admin/match-rounds/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'DRAFT' }) })}>
                  {L.backToDraft}
                </Button>
              </>
            )}
            <Button variant="ghost" disabled={busy} onClick={() => setConfirm('discard')}>{L.discardRound}</Button>
          </div>
        )}
      </div>

      {msg && <p role="alert" data-testid="round-message" className="rounded-md bg-amber-50 px-4 py-2 text-sm text-amber-800">{msg}</p>}

      <Card>
        {round.proposals.length === 0 ? (
          <CardDescription className="p-6">{L.stats.notRun}</CardDescription>
        ) : (
          <dl className="grid grid-cols-2 gap-4 p-6 sm:grid-cols-4" data-testid="round-stats">
            {([
              [L.stats.proposed, stats.proposed ?? 0],
              [L.stats.unmatched, unmatchedTotal],
              [L.stats.mentorsUsed, stats.mentorsUsed ?? 0],
              [L.stats.mentorsAtCapacity, stats.mentorsAtCapacity ?? 0],
            ] as const).map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs uppercase tracking-wide text-gray-500">{label}</dt>
                <dd className="text-2xl font-semibold">{value}</dd>
              </div>
            ))}
            {stats.durationMs != null && <p className="col-span-full text-xs text-gray-500">{fill(L.stats.duration, { ms: stats.durationMs })}</p>}
          </dl>
        )}
      </Card>

      {round.proposals.length > 0 && (
        <Card data-testid="round-unmatched">
          <CardHeader>
            <CardTitle>{L.unmatchedTitle}</CardTitle>
          </CardHeader>
          <div className="space-y-3 px-6 pb-6 text-sm">
            {!diag || diag.unmatchedTotal === 0 ? (
              <p>{L.unmatchedNone}</p>
            ) : (
              <>
                <ul className="space-y-2">
                  {diag.byReason.map((g) => (
                    <li key={g.reason}>
                      <span className="font-medium">{(L.reasons as Record<string, string>)[g.reason] ?? g.reason}</span>{' '}
                      <Badge>{g.count}</Badge>
                      <p className="text-gray-600">{g.menteeIds.slice(0, 10).map(name).join(', ')}{g.menteeIds.length > 10 ? ' …' : ''}</p>
                    </li>
                  ))}
                </ul>
                {diag.topRule && <p>{fill(L.topRule, { rule: ruleName(diag.topRule.rule), n: diag.topRule.pairs })}</p>}
                {diag.shortages.map((s) => (
                  <p key={s.skill}>{fill(L.shortage, { mentees: s.mentees, skill: s.skill, mentors: s.mentorsWithHeadroom })}</p>
                ))}
              </>
            )}
          </div>
        </Card>
      )}

      {round.proposals.length > 0 && (
        <Card>
          <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-6 py-3" role="group" aria-label={L.colState}>
            {FILTERS.map((f) => (
              <Button key={f} size="sm" variant={filter === f ? 'primary' : 'outline'} data-testid={`round-filter-${f}`} onClick={() => { setFilter(f); setSelected(new Set()); }}>
                {L.filters[f]}
              </Button>
            ))}
          </div>

          {editable && (
            <div className="flex flex-wrap items-center gap-2 px-6 py-3" data-testid="round-bulk">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-6 w-6"
                  data-testid="round-select-all"
                  checked={visible.length > 0 && visible.every((p) => p.state === 'PUBLISHED' || selected.has(p.id))}
                  onChange={(e) => setSelected(e.target.checked ? new Set(visible.filter((p) => p.state !== 'PUBLISHED').map((p) => p.id)) : new Set())}
                />
                {L.selectAll}
              </label>
              {selected.size > 0 && (
                <>
                  <span className="text-sm text-gray-600">{fill(L.selected, { n: selected.size })}</span>
                  {(['lock', 'unlock', 'discard', 'restore'] as const).map((a) => (
                    <Button key={a} size="sm" variant="secondary" disabled={busy} data-testid={`round-bulk-${a}`} onClick={() => act(a, [...selected])}>
                      {L.actions[a]}
                    </Button>
                  ))}
                </>
              )}
            </div>
          )}

          <ul className="divide-y divide-gray-100" data-testid="round-proposals">
            {visible.map((p) => {
              const match = { score: p.score ?? 0, breakdown: p.breakdown ?? [], blockedBy: p.blockedBy ?? [] };
              return (
                <li key={p.id} className="space-y-2 px-6 py-4" data-testid={`proposal-${p.menteeId}`}>
                  <div className="flex flex-wrap items-center gap-3">
                    {editable && p.state !== 'PUBLISHED' && (
                      <input
                        type="checkbox"
                        className="h-6 w-6"
                        aria-label={name(p.menteeId)}
                        checked={selected.has(p.id)}
                        onChange={(e) => {
                          const next = new Set(selected);
                          if (e.target.checked) next.add(p.id); else next.delete(p.id);
                          setSelected(next);
                        }}
                      />
                    )}
                    <div className="min-w-[10rem] flex-1">
                      <p className="font-medium">{name(p.menteeId)}</p>
                      <p className="text-sm text-gray-600">
                        {p.mentorId ? `→ ${name(p.mentorId)}` : L.noMentor}
                      </p>
                      {!p.mentorId && p.unmatchedReason && (
                        <p className="text-sm text-gray-600">
                          {(L.reasons as Record<string, string>)[p.unmatchedReason] ?? p.unmatchedReason}
                          {p.blockedBy.length > 0 && ` · ${fill(L.blockedBy, { rules: p.blockedBy.map(ruleName).join(', ') })}`}
                        </p>
                      )}
                    </div>
                    {p.mentorId && <MatchScoreBreakdown compact {...match} />}
                    <Badge variant={STATE_VARIANT[p.state]}>{L.states[p.state]}</Badge>
                    <div className="flex flex-wrap gap-1">
                      {editable && ACTIONS_FOR[p.state]
                        .filter((a) => a !== 'lock' || p.mentorId)
                        .map((a) => {
                          const Icon = ACTION_ICON[a];
                          return (
                            <Button key={a} size="sm" variant="outline" disabled={busy} data-testid={`proposal-${a}-${p.menteeId}`} onClick={() => act(a, [p.id])}>
                              <Icon className="mr-1 h-3.5 w-3.5" aria-hidden />
                              {L.actions[a]}
                            </Button>
                          );
                        })}
                      {editable && p.state === 'DRAFT' && (
                        <Button size="sm" variant="outline" disabled={busy} data-testid={`proposal-swap-${p.menteeId}`} onClick={() => { setSwapFor(swapFor === p.id ? null : p.id); setSearch(''); }}>
                          <Shuffle className="mr-1 h-3.5 w-3.5" aria-hidden />
                          {L.actions.swap}
                        </Button>
                      )}
                      {p.mentorId && (
                        <Button size="sm" variant="ghost" aria-expanded={expanded.has(p.id)} onClick={() => {
                          const next = new Set(expanded);
                          if (next.has(p.id)) next.delete(p.id); else next.add(p.id);
                          setExpanded(next);
                        }}>
                          {expanded.has(p.id) ? L.actions.hide : L.actions.details}
                        </Button>
                      )}
                    </div>
                  </div>

                  {expanded.has(p.id) && p.mentorId && <MatchScoreBreakdown {...match} />}

                  {swapFor === p.id && (
                    <div className="space-y-3 rounded-md border border-gray-200 p-4" data-testid={`swap-panel-${p.menteeId}`}>
                      <p className="font-medium">{L.swapTitle}</p>
                      <div>
                        <p className="mb-1 text-xs uppercase tracking-wide text-gray-500">{L.alternatives}</p>
                        {p.alternatives.filter((a) => a.mentorId !== p.mentorId && a.blockedBy.length === 0).length === 0 ? (
                          <p className="text-sm text-gray-600">{L.noAlternatives}</p>
                        ) : (
                          <ul className="flex flex-wrap gap-2">
                            {p.alternatives
                              .filter((a) => a.mentorId !== p.mentorId && a.blockedBy.length === 0)
                              .map((a) => (
                                <li key={a.mentorId}>
                                  <Button size="sm" variant="secondary" disabled={busy} data-testid={`swap-to-${a.mentorId}`} onClick={() => swap(p.id, a.mentorId)}>
                                    {name(a.mentorId)} · {Math.round(a.score)}%
                                  </Button>
                                </li>
                              ))}
                          </ul>
                        )}
                      </div>
                      <div>
                        <Input
                          type="search"
                          data-testid="round-swap-search"
                          aria-label={L.searchMentors}
                          placeholder={L.searchMentors}
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                        />
                        {searchHits.length > 0 && (
                          <ul className="mt-2 flex flex-wrap gap-2">
                            {searchHits.map((m) => (
                              <li key={m.id}>
                                <Button size="sm" variant="outline" disabled={busy || m.id === p.mentorId} data-testid={`swap-search-${m.id}`} onClick={() => swap(p.id, m.id)}>
                                  {m.fullName}
                                </Button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      <Button size="sm" variant="ghost" onClick={() => setSwapFor(null)}>{L.cancel}</Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <ConfirmDialog
        open={confirm === 'publish'}
        title={L.publishTitle}
        message={fill(L.publishMessage, { n: lockedCount })}
        confirmLabel={fill(L.publishConfirm, { n: lockedCount })}
        cancelLabel={L.cancel}
        loading={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          await call(`/api/admin/match-rounds/${id}/publish`, { method: 'POST' });
          setConfirm(null);
        }}
      />
      <ConfirmDialog
        open={confirm === 'discard'}
        title={L.discardRound}
        message={L.discardRoundConfirm}
        confirmLabel={L.discardRound}
        cancelLabel={L.cancel}
        variant="danger"
        loading={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          const ok = await call(`/api/admin/match-rounds/${id}`, { method: 'DELETE' });
          setConfirm(null);
          if (ok) window.location.href = '/admin/matching/rounds';
        }}
      />
    </div>
  );
}
