'use client';

// The panels you are on, plus (for an admin or a mentor running a round) the
// form that convenes a new one (#824).

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Users } from 'lucide-react';
import { useT, useLocale } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';

interface PanelRow {
  id: string;
  title: string | null;
  subjectName: string | null;
  blind: boolean;
  blindLabel: string | null;
  scheduledAt: string | null;
  closedAt: string | null;
  createdAt: string;
  memberCount: number;
  submittedCount: number;
  complete: boolean;
  mine: boolean;
  iSubmitted: boolean;
}

export default function InterviewsPage() {
  const t = useT();
  const locale = useLocale();
  const [panels, setPanels] = useState<PanelRow[]>([]);
  const [candidates, setCandidates] = useState<{ id: string; fullName: string }[]>([]);
  const [interviewers, setInterviewers] = useState<{ id: string; fullName: string }[]>([]);
  const [subjectId, setSubjectId] = useState('');
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [title, setTitle] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/interview-panels');
    if (res.ok) setPanels((await res.json()).panels ?? []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    fetch('/api/users')
      .then((r) => (r.ok ? r.json() : { users: [] }))
      .then((d) => {
        const users = (d.users ?? []) as { id: string; fullName: string; role: string; isActive?: boolean }[];
        setCandidates(users.filter((u) => u.role === 'MENTEE'));
        setInterviewers(users.filter((u) => u.role === 'MENTOR' || u.role === 'ADMIN'));
      })
      .catch(() => {});
  }, []);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const interviewerIds = Object.keys(chosen).filter((k) => chosen[k]);
      const res = await fetch('/api/interview-panels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subjectId,
          interviewerIds,
          title: title.trim() || undefined,
          scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Failed');
      setSubjectId('');
      setChosen({});
      setTitle('');
      setScheduledAt('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const canCreate = !!subjectId && Object.values(chosen).some(Boolean);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.interviewPanel.title}</h1>
        <p className="text-gray-500 mt-1">{t.interviewPanel.subtitle}</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Users className="h-5 w-5 text-blue-600" />
              <CardTitle>{t.interviewPanel.newPanel}</CardTitle>
            </div>
          </CardHeader>
          {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5" htmlFor="panel-subject">
                {t.interviewPanel.candidate}
              </label>
              <select
                id="panel-subject"
                value={subjectId}
                onChange={(e) => setSubjectId(e.target.value)}
                data-testid="panel-subject"
                className="block w-full rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-3 py-2 text-sm"
              >
                <option value="">–</option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>{c.fullName}</option>
                ))}
              </select>
            </div>
            <div>
              <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                {t.interviewPanel.interviewers}
              </span>
              <div className="max-h-48 overflow-y-auto space-y-1" data-testid="panel-interviewers">
                {interviewers.map((u) => (
                  <label key={u.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={!!chosen[u.id]}
                      onChange={(e) => setChosen((p) => ({ ...p, [u.id]: e.target.checked }))}
                    />
                    <span>{u.fullName}</span>
                  </label>
                ))}
              </div>
            </div>
            <Input label={t.interviewPanel.panelTitle} placeholder={t.interviewPanel.titlePlaceholder} value={title} onChange={(e) => setTitle(e.target.value)} />
            <Input label={t.interviewPanel.scheduledAt} type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
            <Button className="w-full" loading={busy} disabled={!canCreate} onClick={create} data-testid="panel-create">
              {t.interviewPanel.create}
            </Button>
          </div>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t.interviewPanel.title}</CardTitle>
          </CardHeader>
          {panels.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">{t.interviewPanel.none}</p>
          ) : (
            <div className="space-y-3" data-testid="panel-list">
              {panels.map((p) => (
                <div key={p.id} data-testid={`panel-${p.id}`} className="py-2 border-b border-gray-50 dark:border-gray-800 last:border-0">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <Link href={`/interviews/${p.id}`} className="text-sm font-medium text-blue-600 hover:underline truncate block">
                        {p.title || t.interviewPanel.title} ·{' '}
                        {p.blind ? `${t.interviewPanel.blindLabelPrefix} #${p.blindLabel}` : p.subjectName}
                      </Link>
                      <p className="text-xs text-gray-400">
                        {formatDate(p.createdAt, locale)} ·{' '}
                        {t.interviewPanel.progress
                          .replace('{done}', String(p.submittedCount))
                          .replace('{total}', String(p.memberCount))}
                      </p>
                    </div>
                    <Badge variant={p.complete ? 'success' : 'default'}>
                      {p.closedAt ? t.interviewPanel.closed : p.complete ? t.interviewPanel.complete : t.interviewPanel.waiting}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
