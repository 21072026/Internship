'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { useT } from '@/i18n/client';
import { ROUND_NAME_MAX } from '@/lib/matching/round';

// /admin/matching/rounds (#1796): the tenant's bulk matching rounds and a form
// to open a new one. A round only proposes; nothing here pairs anybody — the
// board's publish is the one place that does. The admin layout gates the role
// server-side, the segment layout the `mentorship` capability.

interface RoundRow {
  id: string;
  name: string;
  status: 'DRAFT' | 'REVIEW' | 'PUBLISHED' | 'DISCARDED';
  createdAt: string;
  cohort: { id: string; name: string } | null;
  _count: { proposals: number };
}

const STATUS_VARIANT = { DRAFT: 'default', REVIEW: 'info', PUBLISHED: 'success', DISCARDED: 'warning' } as const;

export default function MatchRoundsPage() {
  const t = useT();
  const L = t.matchRounds;
  const [rounds, setRounds] = useState<RoundRow[] | null>(null);
  const [cohorts, setCohorts] = useState<{ id: string; name: string }[]>([]);
  const [name, setName] = useState('');
  const [cohortId, setCohortId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/match-rounds');
    setRounds(res.ok ? (await res.json()).rounds : []);
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    fetch('/api/cohorts')
      .then((r) => (r.ok ? r.json() : { cohorts: [] }))
      .then((d) => setCohorts((d.cohorts ?? []).map((c: { id: string; name: string }) => ({ id: c.id, name: c.name }))))
      .catch(() => {});
  }, []);

  const create = async () => {
    setBusy(true);
    setError('');
    const res = await fetch('/api/admin/match-rounds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), ...(cohortId ? { cohortId } : {}) }),
    });
    setBusy(false);
    if (!res.ok) return setError(L.errors.generic);
    const { round } = await res.json();
    window.location.href = `/admin/matching/rounds/${round.id}`;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{L.title}</h1>
          <p className="mt-1 max-w-2xl text-sm text-gray-600">{L.intro}</p>
        </div>
        <Link href="/admin/matching" className="text-sm font-medium text-blue-700 hover:underline">{L.rulesLink}</Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{L.newRound}</CardTitle>
        </CardHeader>
        <div className="flex flex-wrap items-end gap-3 px-6 pb-6">
          <div className="min-w-[14rem] flex-1">
            <Input
              data-testid="round-name"
              aria-label={L.newRound}
              placeholder={L.namePlaceholder}
              maxLength={ROUND_NAME_MAX}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="min-w-[14rem]">
            <Select
              data-testid="round-cohort"
              aria-label={L.cohortLabel}
              value={cohortId}
              onChange={(e) => setCohortId(e.target.value)}
              options={[{ value: '', label: L.noCohort }, ...cohorts.map((c) => ({ value: c.id, label: c.name }))]}
            />
          </div>
          <Button data-testid="round-create" onClick={create} loading={busy} disabled={!name.trim()}>
            <Plus className="mr-1 h-4 w-4" aria-hidden />
            {L.create}
          </Button>
        </div>
        {error && <p role="alert" className="px-6 pb-4 text-sm text-red-700">{error}</p>}
      </Card>

      <Card>
        {rounds === null ? null : rounds.length === 0 ? (
          <CardDescription className="p-6">{L.empty}</CardDescription>
        ) : (
          <ul className="divide-y divide-gray-100" data-testid="round-list">
            {rounds.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
                <div className="min-w-0">
                  <Link href={`/admin/matching/rounds/${r.id}`} className="font-medium text-blue-700 hover:underline">{r.name}</Link>
                  <p className="text-sm text-gray-600">
                    {r.cohort ? `${r.cohort.name} · ` : ''}
                    {L.proposalsCount.replace('{n}', String(r._count.proposals))}
                  </p>
                </div>
                <Badge variant={STATUS_VARIANT[r.status]}>{L.statuses[r.status]}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
