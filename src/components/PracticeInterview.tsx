'use client';

import { useCallback, useEffect, useState } from 'react';
import { MessagesSquare, Send } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { AiBadge } from '@/components/AiBadge';
import { AiText } from '@/components/ai/AiText';
import { ArtifactMeta, type ArtifactInfo } from '@/components/ai/ArtifactMeta';
import { PracticeReportView } from '@/components/ai/PracticeReportView';
import { useT } from '@/i18n/client';
import { PRACTICE_ANSWER_MAX, readReport, type PracticeTurn } from '@/lib/practiceInterviewRules';
import type { PracticeReport } from '@/lib/practiceInterviewRules';

// A text-only practice interview on the mentee portal (#2051). Free: every
// denial reads as the same neutral "not available right now" — no budget, no
// plan, no upgrade, ever. Text only: no microphone, no camera, no recording.
// The report is private until the mentee shares it with their mentor.

interface SessionView { id: string; role: string; status: string; maxTurns: number; turns: PracticeTurn[] }
interface Finished extends SessionView { report: (ArtifactInfo & { content: string }) | null }
interface State {
  configured: boolean;
  targetPosition: string | null;
  roles: { id: string; title: string; company: string }[];
  active: SessionView | null;
  finished: Finished[];
}

export function PracticeInterview() {
  const t = useT();
  const p = t.practiceInterview;
  const [state, setState] = useState<State | null>(null);
  const [roleId, setRoleId] = useState('');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [justFinished, setJustFinished] = useState<{ report: PracticeReport; artifact: ArtifactInfo | null } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/interview-prep/session');
    if (res.ok) setState(await res.json());
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (!state) return null;
  const latest = state.finished.find((f) => f.report);
  const latestReport = justFinished?.report ?? (latest?.report ? readReport(latest.report.content) : null);
  const latestArtifact = justFinished?.artifact ?? latest?.report ?? null;
  // Hidden without a provider unless there is something to read.
  if (!state.configured && !state.active && !latestReport) return null;

  const fail = (code?: string) => setNotice(code === 'no_position' ? p.noPosition : p.unavailable);

  const start = async () => {
    setBusy(true);
    setNotice('');
    setJustFinished(null);
    try {
      const res = await fetch('/api/interview-prep/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(roleId ? { requisitionId: roleId } : {}) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return fail(body.code);
      setState((s) => (s ? { ...s, active: body.session } : s));
    } catch {
      fail();
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!state.active || !answer.trim()) return;
    setBusy(true);
    setNotice('');
    try {
      const res = await fetch(`/api/interview-prep/session/${state.active.id}/turn`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer: answer.trim() }) });
      const body = await res.json().catch(() => ({}));
      // Unavailable: nothing was stored, so the answer stays in the box.
      if (!res.ok) return fail(body.code);
      setAnswer('');
      if (body.report) {
        setJustFinished({ report: body.report, artifact: body.artifact ?? null });
        setState((s) => (s ? { ...s, active: null } : s));
        await load();
      } else {
        setState((s) => (s ? { ...s, active: body.session } : s));
      }
    } catch {
      fail();
    } finally {
      setBusy(false);
    }
  };

  const active = state.active;
  const current = active?.turns[active.turns.length - 1];
  const answeredCount = active ? active.turns.filter((x) => typeof x.a === 'string').length : 0;

  return (
    <Card data-testid="practice-interview">
      <CardHeader>
        <div className="flex items-center gap-2">
          <MessagesSquare className="h-5 w-5 text-indigo-600" aria-hidden />
          <CardTitle>{p.title}</CardTitle>
        </div>
      </CardHeader>
      <p className="text-sm text-gray-600 dark:text-gray-400">{p.hint}</p>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{p.textOnly}</p>

      {!active && state.configured && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          {state.roles.length > 0 && (
            <select value={roleId} onChange={(e) => setRoleId(e.target.value)} className="rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800" data-testid="practice-role" aria-label={p.role}>
              <option value="">{state.targetPosition ? p.targetRole.replace('{role}', state.targetPosition) : p.role}</option>
              {state.roles.map((r) => <option key={r.id} value={r.id}>{r.title} · {r.company}</option>)}
            </select>
          )}
          <Button type="button" onClick={() => void start()} loading={busy} data-testid="practice-start">{latestReport ? p.again : p.start}</Button>
        </div>
      )}

      {active && (
        <div className="mt-3 space-y-3" data-testid="practice-active">
          <p className="text-xs font-medium text-gray-500" data-testid="practice-progress">
            {p.question.replace('{n}', String(Math.min(answeredCount + 1, active.maxTurns))).replace('{max}', String(active.maxTurns))} · {active.role}
          </p>
          <ol className="space-y-2">
            {active.turns.slice(0, -1).map((turn, i) => (
              <li key={i} className="rounded-lg bg-gray-50 p-2 text-sm dark:bg-gray-800/50">
                <AiText as="p" text={turn.q} className="font-medium" />
                <p className="mt-1 whitespace-pre-wrap text-gray-700 dark:text-gray-300">{turn.a}</p>
                {turn.note && <AiText as="p" text={turn.note} className="mt-1 text-xs text-indigo-700 dark:text-indigo-300" />}
              </li>
            ))}
          </ol>
          {current && (
            <div>
              <AiBadge />
              <AiText text={current.q} className="mt-1 font-medium text-gray-900 dark:text-gray-100" testId="practice-current-question" />
              <Textarea value={answer} onChange={(e) => setAnswer(e.target.value)} rows={4} maxLength={PRACTICE_ANSWER_MAX} showCounter placeholder={p.answerPlaceholder} data-testid="practice-answer" className="mt-2" />
              <div className="mt-2 flex justify-end">
                <Button type="button" onClick={() => void send()} loading={busy} disabled={!answer.trim()} data-testid="practice-send">
                  <Send className="mr-1 h-4 w-4" aria-hidden /> {p.send}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {notice && <p className="mt-2 text-xs text-amber-700 dark:text-amber-400" role="status" data-testid="practice-notice">{notice}</p>}

      {!active && latestReport && (
        <div className="mt-4 rounded-lg border border-indigo-100 p-3 dark:border-indigo-900">
          <p className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">{p.reportTitle}</p>
          <AiBadge note className="mb-2" />
          <PracticeReportView report={latestReport} />
          {latestArtifact && <ArtifactMeta key={latestArtifact.id} artifact={latestArtifact} canShare />}
        </div>
      )}
    </Card>
  );
}
