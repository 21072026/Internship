'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { Badge } from '@/components/ui/Badge';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { fillTemplate } from '@/components/ui/fillTemplate';
import { useModalFocus } from '@/components/ui/useModalFocus';
import { InterviewRequestForm } from '@/components/InterviewRequestForm';
import { useT, useLocale } from '@/i18n/client';
import { formatDateTimeWithZone } from '@/lib/relativeTime';
import { viewerTimeZone } from '@/lib/timezone';
import { UNSPECIFIED_INTERVIEW_DECLINE_REASON } from '@/lib/interviewDeclineReasons';
import {
  APPLICATION_STAGES,
  COMPANY_TARGET_STAGES,
  DISPOSITION_CODES,
  nextStages,
  type ApplicationStage,
} from '@/lib/applications';

// The applicant board of one requisition (#1838): a column per application
// stage with the count the server computed (a groupBy, never the length of the
// loaded page), filters that run in SQL, per-column paging, a move control on
// every card (a select, so it is keyboard-reachable — there is no drag), bulk
// moves through /api/applications/bulk-stage, and a drawer with the fields the
// company candidate detail already shows — no e-mail, no phone.

type Card = {
  id: string;
  stage: ApplicationStage;
  createdAt: string;
  mentee: { id: string; fullName: string; city: string | null };
  matchedSkills: string[];
  answered: number;
};
type Column = { items: Card[]; page: number; hasMore: boolean };
type Requisition = { id: string; title: string; status: string; openings: number; filled: number };
type Interview = {
  id: string;
  menteeId: string;
  status: string;
  declineReasonCode: string | null;
  declineNote: string | null;
  scheduledAt: string | null;
  cancelReason: string | null;
};
type Filters = { q: string; skill: string; city: string; stage: string };
const EMPTY_FILTERS: Filters = { q: '', skill: '', city: '', stage: '' };

function query(filters: Filters, extra: Record<string, string> = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...filters, ...extra })) if (value) params.set(key, value);
  return params.toString();
}

/** The stages a company may move a card to from where it stands. */
function companyMoves(stage: string): ApplicationStage[] {
  return nextStages(stage).filter((s) => COMPANY_TARGET_STAGES.includes(s));
}

export default function CompanyRequisitionBoardPage() {
  const { id } = useParams<{ id: string }>();
  const t = useT();
  const text = t.requisitionPipeline;
  const irText = t.interviewRequests;
  const locale = useLocale();
  const [requisition, setRequisition] = useState<Requisition | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [columns, setColumns] = useState<Record<string, Column>>({});
  const [requests, setRequests] = useState<Interview[]>([]);
  const [candidates, setCandidates] = useState<{ id: string; fullName: string }[]>([]);
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkStage, setBulkStage] = useState('');
  const [bulkReason, setBulkReason] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [drawerFor, setDrawerFor] = useState<Card | null>(null);
  const [addId, setAddId] = useState('');
  const [addNote, setAddNote] = useState('');

  const load = useCallback(async () => {
    const [board, interviews, rels] = await Promise.all([
      fetch(`/api/company/requisitions/${id}/applications?${query(filters)}`),
      fetch(`/api/interview-requests?requisitionId=${id}`).then((r) => (r.ok ? r.json() : { requests: [] })),
      fetch('/api/mentorship').then((r) => (r.ok ? r.json() : { relations: [] })),
    ]);
    if (!board.ok) { setLoadFailed(true); return; }
    const body = await board.json();
    setLoadFailed(false);
    setRequisition(body.requisition);
    setCounts(body.counts ?? {});
    setColumns(body.columns ?? {});
    setRequests(interviews.requests ?? []);
    setCandidates((rels.relations ?? []).map((relation: { mentee: { id: string; fullName: string } }) => relation.mentee));
    setSelected(new Set());
  }, [id, filters]);
  useEffect(() => { void load(); }, [load]);

  const loadMore = async (stage: ApplicationStage) => {
    const next = (columns[stage]?.page ?? 1) + 1;
    const res = await fetch(`/api/company/requisitions/${id}/applications?${query(filters, { column: stage, page: String(next) })}`);
    if (!res.ok) { setError(text.errors.loadFailed); return; }
    const body = await res.json();
    const page: Column | undefined = body.columns?.[stage];
    if (!page) return;
    setColumns((prev) => ({ ...prev, [stage]: { items: [...(prev[stage]?.items ?? []), ...page.items], page: page.page, hasMore: page.hasMore } }));
  };

  const move = async (card: Card, toStage: string, dispositionCode?: string) => {
    setError(''); setNotice('');
    const res = await fetch(`/api/applications/${card.id}/stage`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toStage, expectedStage: card.stage, ...(dispositionCode ? { dispositionCode } : {}) }),
    });
    if (res.status === 409) setError(text.errors.conflict);
    else if (!res.ok) { setError(text.errors.moveFailed); return; }
    await load();
  };

  const bulkMove = async () => {
    setError(''); setNotice('');
    const res = await fetch('/api/applications/bulk-stage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [...selected], toStage: bulkStage, ...(bulkStage === 'REJECTED' ? { dispositionCode: bulkReason } : {}) }),
    });
    if (!res.ok) { setError(text.errors.moveFailed); return; }
    const body = (await res.json()) as { moved: string[]; skipped: unknown[] };
    setNotice(text.bulkResult.replace('{moved}', String(body.moved.length)).replace('{skipped}', String(body.skipped.length)));
    setBulkStage(''); setBulkReason('');
    await load();
  };

  const addCandidate = async () => {
    setError('');
    const res = await fetch('/api/company/interests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requisitionId: id, menteeId: addId, status: 'SHORTLISTED', note: addNote }) });
    if (!res.ok) setError(irText.errors.saveFailed); else { setAddId(''); setAddNote(''); await load(); }
  };

  const requestInterview = async (menteeId: string, payload: { note?: string; proposedSlots?: string[] }) => {
    const res = await fetch('/api/interview-requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requisitionId: id, menteeId, ...payload }) });
    if (!res.ok) setError((await res.json()).error ?? irText.errors.saveFailed); else await load();
  };

  const toggle = (cardId: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(cardId)) next.delete(cardId); else next.add(cardId);
    return next;
  });

  // The newest request per candidate — the list arrives newest first, so the first one wins.
  const requestFor = useMemo(() => {
    const byMentee = new Map<string, Interview>();
    for (const r of requests) if (!byMentee.has(r.menteeId)) byMentee.set(r.menteeId, r);
    return byMentee;
  }, [requests]);
  const reasonOptions = DISPOSITION_CODES.map((code) => ({ value: code, label: t.dispositionCodes[code] }));

  if (loadFailed && !requisition) return <p className="py-10 text-center text-red-600" role="alert">{text.errors.loadFailed}</p>;
  if (!requisition) return <p className="py-10 text-center text-gray-500" data-testid="page-loading">{t.common.loading}</p>;
  const fillPct = requisition.openings > 0 ? Math.min(100, Math.round((requisition.filled / requisition.openings) * 100)) : 0;
  const submitFilters = (e: FormEvent) => { e.preventDefault(); setFilters(draft); };

  return (
    <div data-testid="requisition-board">
      <Link href="/company/requisitions" className="text-sm text-blue-600 dark:text-blue-400">← {t.requisitions.title}</Link>
      <header className="my-5 space-y-3" data-testid="requisition-header">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{requisition.title}</h1>
          <Badge data-testid="requisition-status">{(t.requisitions.statuses as Record<string, string>)[requisition.status] ?? requisition.status}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm text-gray-700 dark:text-gray-300">
          <span>{text.openings}: <strong data-testid="requisition-openings">{requisition.openings}</strong></span>
          <span>{text.filled}: <strong data-testid="requisition-filled">{requisition.filled}</strong></span>
          <div
            className="h-2 w-40 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={requisition.openings}
            aria-valuenow={requisition.filled}
            aria-label={text.fillProgress.replace('{filled}', String(requisition.filled)).replace('{openings}', String(requisition.openings))}
          >
            <div className="h-full bg-green-600" style={{ width: `${fillPct}%` }} />
          </div>
        </div>
      </header>

      {error && <p className="mb-3 text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      {notice && <p className="mb-3 text-sm text-green-700 dark:text-green-400" role="status" data-testid="board-notice">{notice}</p>}

      <form onSubmit={submitFilters} className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5" data-testid="board-filters">
        <Input aria-label={text.filters.search} placeholder={text.filters.search} value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} data-testid="board-filter-q" />
        <Input aria-label={text.filters.skill} placeholder={text.filters.skill} value={draft.skill} onChange={(e) => setDraft({ ...draft, skill: e.target.value })} data-testid="board-filter-skill" />
        <Input aria-label={text.filters.city} placeholder={text.filters.city} value={draft.city} onChange={(e) => setDraft({ ...draft, city: e.target.value })} data-testid="board-filter-city" />
        <Select
          aria-label={text.filters.stage}
          value={draft.stage}
          onChange={(e) => setDraft({ ...draft, stage: e.target.value })}
          options={[{ value: '', label: text.filters.allStages }, ...APPLICATION_STAGES.map((s) => ({ value: s, label: text.stages[s] }))]}
          data-testid="board-filter-stage"
        />
        <div className="flex gap-2">
          <Button type="submit" data-testid="board-filter-apply">{text.filters.apply}</Button>
          <Button type="button" variant="outline" onClick={() => { setDraft(EMPTY_FILTERS); setFilters(EMPTY_FILTERS); }}>{text.filters.reset}</Button>
        </div>
      </form>

      {selected.size > 0 && (
        <div className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-900 dark:bg-blue-950/30" data-testid="bulk-bar">
          <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{text.selectedCount.replace('{count}', String(selected.size))}</span>
          <div className="w-48">
            <Select aria-label={text.moveTo} value={bulkStage} onChange={(e) => setBulkStage(e.target.value)} placeholder={text.moveTo}
              options={COMPANY_TARGET_STAGES.map((s) => ({ value: s, label: text.stages[s] }))} data-testid="bulk-stage" />
          </div>
          {bulkStage === 'REJECTED' && (
            <div className="w-56">
              <Select aria-label={text.reason} value={bulkReason} onChange={(e) => setBulkReason(e.target.value)} placeholder={text.reasonPlaceholder} options={reasonOptions} data-testid="bulk-reason" />
            </div>
          )}
          <Button disabled={!bulkStage || (bulkStage === 'REJECTED' && !bulkReason)} onClick={() => void bulkMove()} data-testid="bulk-move">{text.bulkMove}</Button>
          <Button variant="outline" onClick={() => setSelected(new Set())}>{text.clearSelection}</Button>
        </div>
      )}

      <div className="overflow-x-auto pb-3" tabIndex={0} role="region" aria-label={requisition.title} data-testid="applicant-board">
        <div className="flex gap-4">
          {APPLICATION_STAGES.map((stage) => {
            const column = columns[stage];
            const headingId = `col-${stage}`;
            return (
              <section key={stage} aria-labelledby={headingId} className="w-72 flex-shrink-0 rounded-xl bg-gray-50 p-3 dark:bg-gray-900/60" data-testid={`applicant-column-${stage}`}>
                <h2 id={headingId} className="mb-3 flex items-center justify-between text-sm font-semibold text-gray-900 dark:text-gray-100">
                  <span>{text.stages[stage]}</span>
                  <span
                    className="rounded-full bg-white px-2 py-0.5 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-200"
                    title={text.columnCount.replace('{count}', String(counts[stage] ?? 0)).replace('{stage}', text.stages[stage])}
                    data-testid={`applicant-count-${stage}`}
                  >
                    {counts[stage] ?? 0}
                  </span>
                </h2>
                {!column || column.items.length === 0 ? (
                  <p className="text-xs text-gray-600 dark:text-gray-400">{text.columnEmpty}</p>
                ) : (
                  <ul className="space-y-3">
                    {column.items.map((card) => (
                      <ApplicantCard
                        key={card.id}
                        card={card}
                        selected={selected.has(card.id)}
                        onToggle={() => toggle(card.id)}
                        onOpen={() => setDrawerFor(card)}
                        onMove={(to, code) => void move(card, to, code)}
                        request={requestFor.get(card.mentee.id)}
                        onRequestInterview={(payload) => requestInterview(card.mentee.id, payload)}
                        reasonOptions={reasonOptions}
                        locale={locale}
                      />
                    ))}
                  </ul>
                )}
                {column?.hasMore && (
                  <Button size="sm" variant="outline" className="mt-3 w-full" onClick={() => void loadMore(stage)} data-testid={`applicant-more-${stage}`}>{text.loadMore}</Button>
                )}
              </section>
            );
          })}
        </div>
      </div>

      <details className="mt-6 rounded-lg border border-gray-200 p-3 dark:border-gray-800" data-testid="add-candidate">
        <summary className="cursor-pointer text-sm font-medium text-gray-900 dark:text-gray-100">{text.addCandidate}</summary>
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          <Select aria-label={irText.selectCandidate} value={addId} onChange={(e) => setAddId(e.target.value)} placeholder={irText.selectCandidate}
            options={candidates.map((c) => ({ value: c.id, label: c.fullName }))} data-testid="add-candidate-select" />
          <Textarea aria-label={irText.note} value={addNote} onChange={(e) => setAddNote(e.target.value)} placeholder={irText.note} />
        </div>
        <Button className="mt-3" disabled={!addId} onClick={() => void addCandidate()} data-testid="add-candidate-submit">{irText.shortlistAction}</Button>
      </details>

      {drawerFor && <CandidateDrawer card={drawerFor} onClose={() => setDrawerFor(null)} />}
    </div>
  );
}

function ApplicantCard({ card, selected, onToggle, onOpen, onMove, request, onRequestInterview, reasonOptions, locale }: {
  card: Card;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onMove: (toStage: string, dispositionCode?: string) => void;
  request: Interview | undefined;
  onRequestInterview: (payload: { note?: string; proposedSlots?: string[] }) => Promise<void>;
  reasonOptions: { value: string; label: string }[];
  locale: string;
}) {
  const t = useT();
  const text = t.requisitionPipeline;
  const irText = t.interviewRequests;
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const moves = companyMoves(card.stage);
  return (
    <li className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm dark:border-gray-700 dark:bg-gray-800" data-testid={`applicant-card-${card.id}`}>
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4"
          checked={selected}
          onChange={onToggle}
          aria-label={text.select.replace('{name}', card.mentee.fullName)}
          data-testid={`applicant-select-${card.id}`}
        />
        <div className="min-w-0 flex-1">
          <button type="button" className="text-left font-medium text-blue-700 hover:underline dark:text-blue-300" onClick={onOpen} data-testid={`applicant-open-${card.id}`}>
            {card.mentee.fullName}
          </button>
          <p className="text-xs text-gray-600 dark:text-gray-400">
            {fillTemplate(text.applied, { when: <RelativeTime date={card.createdAt} locale={locale} /> })}
            {card.mentee.city ? ` · ${card.mentee.city}` : ''}
          </p>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {card.matchedSkills.length === 0
          ? <span className="text-xs text-gray-600 dark:text-gray-400">{text.noMatchedSkills}</span>
          : card.matchedSkills.map((skill) => <Badge key={skill} variant="success">{skill}</Badge>)}
      </div>
      {card.answered > 0 && <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">{text.answered.replace('{count}', String(card.answered))}</p>}

      {request && (
        <div className="mt-2 space-y-1 text-sm">
          <Badge>{irText.statuses[request.status as keyof typeof irText.statuses]}</Badge>
          {request.status === 'SCHEDULED' && request.scheduledAt && (
            <p className="font-medium text-gray-900 dark:text-gray-100" data-testid="interview-scheduled-at">
              {irText.scheduledAt.replace('{when}', formatDateTimeWithZone(request.scheduledAt, locale, viewerTimeZone(null)))}
            </p>
          )}
          {request.status === 'CANCELLED' && (
            <p className="text-gray-600 dark:text-gray-300" data-testid="interview-cancelled">
              {request.cancelReason ? irText.cancelledWithReason.replace('{reason}', request.cancelReason) : irText.cancelledNoReason}
            </p>
          )}
          {request.status === 'DECLINED' && (
            <div className="rounded-md bg-red-50 p-2 text-red-800 dark:bg-red-950/30 dark:text-red-200" data-testid={`interview-decline-reason-${request.id}`}>
              <p>
                <span className="font-medium">{irText.declineReasonDisplay}:</span>{' '}
                {(t.interviewDeclineReasons as Record<string, string>)[request.declineReasonCode ?? UNSPECIFIED_INTERVIEW_DECLINE_REASON]
                  ?? request.declineReasonCode
                  ?? t.interviewDeclineReasons.UNSPECIFIED}
              </p>
              {request.declineNote && <p className="mt-1 whitespace-pre-wrap">{request.declineNote}</p>}
            </div>
          )}
        </div>
      )}
      {!request && card.stage === 'SHORTLISTED' && (
        <details className="mt-2" data-testid={`applicant-interview-${card.id}`}>
          <summary className="cursor-pointer text-sm text-blue-700 dark:text-blue-300">{irText.requestInterview}</summary>
          <div className="mt-2"><InterviewRequestForm onSubmit={onRequestInterview} /></div>
        </details>
      )}

      {moves.length === 0 ? (
        <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">{text.noMoves}</p>
      ) : (
        <div className="mt-3 space-y-2">
          <Select aria-label={`${text.moveTo}: ${card.mentee.fullName}`} value={to} onChange={(e) => setTo(e.target.value)} placeholder={text.moveTo}
            options={moves.map((s) => ({ value: s, label: text.stages[s] }))} data-testid={`applicant-move-${card.id}`} />
          {to === 'REJECTED' && (
            <Select aria-label={text.reason} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={text.reasonPlaceholder} options={reasonOptions} data-testid={`applicant-reason-${card.id}`} />
          )}
          <Button size="sm" disabled={!to || (to === 'REJECTED' && !reason)} onClick={() => onMove(to, to === 'REJECTED' ? reason : undefined)} data-testid={`applicant-move-submit-${card.id}`}>
            {text.move}
          </Button>
        </div>
      )}
    </li>
  );
}

type CandidateDetail = {
  id: string;
  fullName: string;
  university: string | null;
  department: string | null;
  graduationYear: number | null;
  city: string | null;
  bio: string | null;
  targetPosition: string | null;
  skills: unknown;
};

function CandidateDrawer({ card, onClose }: { card: Card; onClose: () => void }) {
  const t = useT();
  const text = t.requisitionPipeline;
  const ref = useModalFocus<HTMLDivElement>(true, onClose);
  const [detail, setDetail] = useState<CandidateDetail | null>(null);
  const [verified, setVerified] = useState<{ evaluations: unknown[]; projects: unknown[] } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(`/api/company/candidates/${card.mentee.id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body) => { if (live) { setDetail(body.candidate); setVerified(body.verified); } })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [card.mentee.id]);
  const skills = Array.isArray(detail?.skills) ? (detail.skills as unknown[]).filter((s): s is string => typeof s === 'string') : [];
  const education = [detail?.university, detail?.department, detail?.graduationYear].filter(Boolean).join(' · ');
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="candidate-drawer-title"
        className="h-full w-full max-w-md overflow-y-auto bg-white p-5 shadow-xl dark:bg-gray-900"
        onClick={(e) => e.stopPropagation()}
        data-testid="candidate-drawer"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-gray-600 dark:text-gray-400">{text.drawerTitle}</p>
            <h2 id="candidate-drawer-title" className="text-xl font-bold text-gray-900 dark:text-gray-100">{card.mentee.fullName}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label={text.close} className="rounded p-2 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800">
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        {failed ? (
          <p className="text-sm text-gray-600 dark:text-gray-400">{text.noDetail}</p>
        ) : !detail ? (
          <p className="text-sm text-gray-600 dark:text-gray-400">{t.common.loading}</p>
        ) : (
          <div className="space-y-3 text-sm">
            {detail.targetPosition && <p className="font-medium text-blue-700 dark:text-blue-300">{detail.targetPosition}</p>}
            <dl className="space-y-3">
              {education && <div><dt className="font-medium text-gray-900 dark:text-gray-100">{text.education}</dt><dd className="text-gray-700 dark:text-gray-300">{education}</dd></div>}
              {detail.city && <div><dt className="font-medium text-gray-900 dark:text-gray-100">{text.city}</dt><dd className="text-gray-700 dark:text-gray-300">{detail.city}</dd></div>}
              {skills.length > 0 && (
                <div>
                  <dt className="font-medium text-gray-900 dark:text-gray-100">{text.skills}</dt>
                  <dd className="mt-1 flex flex-wrap gap-1">{skills.map((s) => <Badge key={s} variant={card.matchedSkills.includes(s) ? 'success' : 'default'}>{s}</Badge>)}</dd>
                </div>
              )}
              {verified && (
                <div data-testid="candidate-drawer-verified">
                  <dt className="font-medium text-gray-900 dark:text-gray-100">{t.company.verifiedTitle}</dt>
                  <dd className="text-gray-700 dark:text-gray-300">
                    {t.company.verifiedEvaluations}: {verified.evaluations.length} · {t.company.verifiedProjects}: {verified.projects.length}
                  </dd>
                </div>
              )}
            </dl>
            {detail.bio && <p className="whitespace-pre-line text-gray-700 dark:text-gray-300">{detail.bio}</p>}
          </div>
        )}
        <Link href={`/company/candidates/${card.mentee.id}`} className="mt-5 inline-block text-sm font-medium text-blue-700 hover:underline dark:text-blue-300">{text.openProfile}</Link>
      </div>
    </div>
  );
}
