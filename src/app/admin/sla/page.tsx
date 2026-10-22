'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlarmClock } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { LoadErrorCard } from '@/components/ui/LoadErrorCard';
import { fillTemplate } from '@/components/ui/fillTemplate';
import { SlaComplianceCard } from '@/components/admin/SlaComplianceCard';
import { useResolvedStages, useStageLabel } from '@/lib/pipelineStagesClient';
import { formatDate } from '@/lib/relativeTime';
import { useLocale, useT } from '@/i18n/client';

// /admin/sla (#1723) — the work queue of stage deadlines that passed and were
// not yet resolved by a stage move (SlaBreach, #1722), and the compliance rate
// that queue is supposed to push up. Reads GET /api/admin/sla; acknowledges
// through POST /api/admin/sla/acknowledge; snoozes through
// POST /api/admin/sla/[id]/snooze. Every one of those checks ADMIN and scopes
// to the caller's tenant at the route — this page being under /admin is not
// the authorization.

interface Item {
  id: string;
  relationId: string;
  menteeId: string;
  menteeName: string;
  ownerId: string;
  ownerName: string;
  stageKey: string;
  dueAt: string;
  daysPastDue: number;
  level: number;
  acknowledgedAt: string | null;
  snoozedUntil: string | null;
}

interface QueueBody {
  items: Item[];
  total: number;
  page: number;
  pageSize: number;
  owners: { id: string; fullName: string }[];
}

const DAY = 24 * 60 * 60 * 1000;

export default function AdminSlaPage() {
  const t = useT();
  const S = t.slaQueue;
  const locale = useLocale();
  const stages = useResolvedStages();
  const stageLabel = useStageLabel();

  const [q, setQ] = useState('');
  const [stage, setStage] = useState('');
  const [level, setLevel] = useState('');
  const [owner, setOwner] = useState('');
  const [ack, setAck] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<QueueBody | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [snoozing, setSnoozing] = useState<string | null>(null);
  const [snoozeDays, setSnoozeDays] = useState('7');
  const [snoozeReason, setSnoozeReason] = useState('');

  const load = useCallback(async () => {
    setFailed(false);
    const sp = new URLSearchParams();
    if (q.trim()) sp.set('q', q.trim());
    if (stage) sp.set('stage', stage);
    if (level) sp.set('level', level);
    if (owner) sp.set('owner', owner);
    if (ack) sp.set('acknowledged', ack);
    sp.set('page', String(page));
    try {
      const res = await fetch(`/api/admin/sla?${sp}`);
      if (!res.ok) throw new Error(String(res.status));
      setData(await res.json());
      setSelected(new Set());
    } catch {
      setFailed(true);
    }
  }, [q, stage, level, owner, ack, page]);

  useEffect(() => {
    const id = setTimeout(load, 250);
    return () => clearTimeout(id);
  }, [load]);

  const acknowledge = async (ids: string[]) => {
    if (ids.length === 0) return;
    setBusy(true);
    try {
      await fetch('/api/admin/sla/acknowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const snooze = async (id: string) => {
    const days = Number(snoozeDays);
    if (!snoozeReason.trim() || !Number.isFinite(days) || days < 1) return;
    setBusy(true);
    try {
      await fetch(`/api/admin/sla/${id}/snooze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ until: new Date(Date.now() + days * DAY).toISOString(), reason: snoozeReason.trim() }),
      });
      setSnoozing(null);
      setSnoozeReason('');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const resetPage = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <AlarmClock className="h-6 w-6 text-blue-600" />
          {S.title}
        </h1>
        <p className="text-sm text-gray-500 mt-1">{S.subtitle}</p>
      </div>

      <SlaComplianceCard />

      <Card>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
          <Input
            type="text"
            value={q}
            placeholder={S.filterPlaceholder}
            aria-label={S.filterPlaceholder}
            data-testid="sla-filter"
            onChange={(e) => resetPage(setQ)(e.target.value)}
          />
          <Select
            aria-label={S.colStage}
            data-testid="sla-filter-stage"
            value={stage}
            onChange={(e) => resetPage(setStage)(e.target.value)}
            options={[{ value: '', label: S.allStages }, ...stages.map((s) => ({ value: s.key, label: s.label }))]}
          />
          <Select
            aria-label={S.colLevel}
            data-testid="sla-filter-level"
            value={level}
            onChange={(e) => resetPage(setLevel)(e.target.value)}
            options={[
              { value: '', label: S.allLevels },
              { value: '1', label: S.levelMentor },
              { value: '2', label: S.levelAdmin },
            ]}
          />
          <Select
            aria-label={S.colOwner}
            data-testid="sla-filter-owner"
            value={owner}
            onChange={(e) => resetPage(setOwner)(e.target.value)}
            options={[{ value: '', label: S.allOwners }, ...(data?.owners ?? []).map((o) => ({ value: o.id, label: o.fullName }))]}
          />
          <Select
            aria-label={S.colState}
            data-testid="sla-filter-ack"
            value={ack}
            onChange={(e) => resetPage(setAck)(e.target.value)}
            options={[
              { value: '', label: S.ackAny },
              { value: 'no', label: S.ackNo },
              { value: 'yes', label: S.ackYes },
            ]}
          />
        </div>

        {selected.size > 0 && (
          <div className="mb-3">
            <Button size="sm" loading={busy} onClick={() => acknowledge(Array.from(selected))} data-testid="sla-ack-selected">
              {fillTemplate(S.acknowledgeSelected, { n: String(selected.size) })}
            </Button>
          </div>
        )}

        {failed ? (
          <LoadErrorCard onRetry={load} />
        ) : !data ? (
          <SkeletonRows />
        ) : data.items.length === 0 ? (
          <p className="text-sm text-gray-500 py-6 text-center" data-testid="sla-empty">
            {S.empty}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="sla-table">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-200 dark:border-gray-700">
                  <th className="py-2 pr-2 w-8" />
                  <th className="py-2 pr-3">{S.colName}</th>
                  <th className="py-2 pr-3">{S.colStage}</th>
                  <th className="py-2 pr-3">{S.colPastDue}</th>
                  <th className="py-2 pr-3">{S.colLevel}</th>
                  <th className="py-2 pr-3">{S.colOwner}</th>
                  <th className="py-2 pr-3">{S.colState}</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {data.items.map((it) => (
                  <tr key={it.id} className="border-b border-gray-100 dark:border-gray-800 align-top" data-testid={`sla-row-${it.id}`}>
                    <td className="py-2 pr-2">
                      <input
                        type="checkbox"
                        aria-label={S.selectRow.replace('{name}', it.menteeName)}
                        checked={selected.has(it.id)}
                        disabled={!!it.acknowledgedAt}
                        onChange={(e) =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(it.id);
                            else next.delete(it.id);
                            return next;
                          })
                        }
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <Link href={`/admin/candidates/${it.menteeId}`} className="text-blue-600 hover:underline">
                        {it.menteeName}
                      </Link>
                    </td>
                    <td className="py-2 pr-3">{stageLabel(it.stageKey)}</td>
                    <td className="py-2 pr-3">{fillTemplate(S.daysPastDue, { n: String(it.daysPastDue) })}</td>
                    <td className="py-2 pr-3">
                      <Badge variant={it.level >= 2 ? 'danger' : 'warning'}>{it.level >= 2 ? S.levelAdmin : S.levelMentor}</Badge>
                    </td>
                    <td className="py-2 pr-3">{it.ownerName}</td>
                    <td className="py-2 pr-3 text-xs text-gray-600 dark:text-gray-400">
                      {it.acknowledgedAt && <div>{S.acknowledged}</div>}
                      {it.snoozedUntil && new Date(it.snoozedUntil).getTime() > Date.now() && (
                        <div>{fillTemplate(S.snoozedUntil, { date: formatDate(it.snoozedUntil, locale) })}</div>
                      )}
                    </td>
                    <td className="py-2 text-right whitespace-nowrap">
                      {!it.acknowledgedAt && (
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => acknowledge([it.id])} data-testid={`sla-ack-${it.id}`}>
                          {S.acknowledge}
                        </Button>
                      )}{' '}
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setSnoozing(snoozing === it.id ? null : it.id)} data-testid={`sla-snooze-${it.id}`}>
                        {S.snooze}
                      </Button>
                      {snoozing === it.id && (
                        <div className="mt-2 flex flex-col gap-2 items-end">
                          <Select
                            aria-label={S.snoozeUntil}
                            value={snoozeDays}
                            onChange={(e) => setSnoozeDays(e.target.value)}
                            options={['3', '7', '14', '30'].map((d) => ({ value: d, label: S.daysPastDue.replace('{n}', d) }))}
                          />
                          <Input
                            type="text"
                            value={snoozeReason}
                            maxLength={500}
                            placeholder={S.snoozeReason}
                            aria-label={S.snoozeReason}
                            data-testid={`sla-snooze-reason-${it.id}`}
                            onChange={(e) => setSnoozeReason(e.target.value)}
                          />
                          <Button size="sm" disabled={busy || !snoozeReason.trim()} onClick={() => snooze(it.id)} data-testid={`sla-snooze-save-${it.id}`}>
                            {S.snoozeSave}
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data && data.total > data.pageSize && (
          <div className="mt-4 flex items-center justify-between text-sm">
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              {S.prev}
            </Button>
            <span>{fillTemplate(S.page, { page: String(page), pages: String(pages) })}</span>
            <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
              {S.next}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
