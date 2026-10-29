'use client';

import { MatchScoreBreakdown } from '@/components/matching/MatchScoreBreakdown';
import type { MatchBreakdownEntry } from '@/lib/matching/types';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import { useT } from '@/i18n/client';
import { APPLICATION_STAGES, DISPOSITION_CODES, canTransition, type ApplicationStage } from '@/lib/applications';

// The admin's requisition detail (#1401): who is on this role (the applicant
// board's rows, flattened), and who would fit it (the matching-candidates list,
// requisitionMatchRule.ts). Adding to the shortlist is POST
// /api/requisitions/[id]/shortlist; taking someone off it is the ordinary stage
// move to REJECTED with a reason. Loading, empty and failed are three different
// states on both lists — never an empty list while the request is in flight.

type Applicant = {
  id: string;
  stage: ApplicationStage;
  source: string;
  mentee: { id: string; fullName: string; city: string | null };
  matchedSkills: string[];
};
type Match = {
  candidate: { id: string; fullName: string; city: string | null; targetPosition: string | null };
  via: 'skills' | 'title';
  direct: string[];
  adjacent: { skill: string; via: string }[];
  application: { id: string; stage: string } | null;
  // The fit score (#2042): orders the list, never removes anybody from it.
  fit: { score: number; breakdown: MatchBreakdownEntry[]; ruleSetVersion: string };
};
type Requisition = {
  id: string; title: string; status: string; openings: number; filled: number; city: string | null;
  requiredSkills: unknown; company: { id: string; name: string }; canonicalSkillCount: number;
};
type Load<T> = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; data: T };

const APPLICANT_PAGE = 50;

export default function AdminRequisitionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const t = useT();
  const text = t.requisitionDetail;
  const [requisition, setRequisition] = useState<Requisition | null>(null);
  const [matches, setMatches] = useState<Load<Match[]>>({ state: 'loading' });
  const [applicants, setApplicants] = useState<Load<Applicant[]>>({ state: 'loading' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [m, b] = await Promise.all([
      fetch(`/api/requisitions/${id}/matches`).catch(() => null),
      fetch(`/api/company/requisitions/${id}/applications?pageSize=${APPLICANT_PAGE}`).catch(() => null),
    ]);
    if (m?.ok) {
      const body = await m.json();
      setRequisition(body.requisition);
      setMatches({ state: 'ready', data: body.matches ?? [] });
    } else setMatches({ state: 'failed' });
    if (b?.ok) {
      const body = await b.json();
      const columns = (body.columns ?? {}) as Record<string, { items: Applicant[] }>;
      setApplicants({ state: 'ready', data: APPLICATION_STAGES.flatMap((s) => columns[s]?.items ?? []) });
    } else setApplicants({ state: 'failed' });
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const shortlist = async (menteeId: string) => {
    setError(''); setBusy(menteeId);
    const res = await fetch(`/api/requisitions/${id}/shortlist`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ menteeId }) });
    setBusy(null);
    if (!res.ok) {
      const code = (await res.json().catch(() => ({}))).code;
      setError(code === 'no_consent' ? text.errors.noConsent : code === 'requisition_closed' ? text.errors.closed : code === 'stage_conflict' ? text.errors.conflict : text.errors.failed);
    }
    await load();
  };

  const remove = async (applicant: Applicant, dispositionCode: string) => {
    setError(''); setBusy(applicant.id);
    const res = await fetch(`/api/applications/${applicant.id}/stage`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toStage: 'REJECTED', expectedStage: applicant.stage, dispositionCode }),
    });
    setBusy(null);
    if (res.status === 409) setError(text.errors.conflict);
    else if (!res.ok) setError(text.errors.failed);
    await load();
  };

  const stageLabel = (stage: string) => (t.requisitionPipeline.stages as Record<string, string>)[stage] ?? stage;
  const skills = Array.isArray(requisition?.requiredSkills) ? (requisition.requiredSkills as unknown[]).filter((s): s is string => typeof s === 'string') : [];

  if (matches.state === 'failed' && !requisition) {
    return <div><BackLink label={t.requisitions.title} /><p className="py-10 text-center text-red-600 dark:text-red-400" role="alert" data-testid="requisition-detail-failed">{text.matchesFailed}</p></div>;
  }
  if (!requisition) return <p className="py-10 text-center text-gray-500" data-testid="page-loading">{t.common.loading}</p>;

  return (
    <div className="space-y-6" data-testid="requisition-detail">
      <BackLink label={t.requisitions.title} />
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{requisition.title}</h1>
          <Badge>{(t.requisitions.statuses as Record<string, string>)[requisition.status] ?? requisition.status}</Badge>
        </div>
        <p className="text-sm text-gray-700 dark:text-gray-300">
          {t.requisitions.company}: <strong>{requisition.company.name}</strong> · {t.requisitions.filled}: <strong>{requisition.filled}/{requisition.openings}</strong>
          {requisition.city ? ` · ${requisition.city}` : ''}
        </p>
        {skills.length > 0 && <div className="flex flex-wrap gap-1" aria-label={t.requisitions.requiredSkills}>{skills.map((s) => <Badge key={s}>{s}</Badge>)}</div>}
      </header>

      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert" data-testid="requisition-detail-error">{error}</p>}

      <Card data-testid="requisition-applicants">
        <CardHeader><CardTitle>{text.applicantsTitle}</CardTitle></CardHeader>
        {applicants.state === 'loading' ? <p className="text-sm text-gray-500">{t.common.loading}</p>
          : applicants.state === 'failed' ? <p className="text-sm text-red-600 dark:text-red-400" role="alert">{text.applicantsFailed}</p>
          : applicants.data.length === 0 ? <p className="text-sm text-gray-600 dark:text-gray-400" data-testid="requisition-applicants-empty">{text.applicantsEmpty}</p>
          : <ul className="divide-y divide-gray-100 dark:divide-gray-800">
              {applicants.data.map((a) => (
                <ApplicantRow key={a.id} applicant={a} stageLabel={stageLabel} busy={busy === a.id} onRemove={(code) => void remove(a, code)} />
              ))}
            </ul>}
      </Card>

      <Card data-testid="requisition-matches">
        <CardHeader>
          <CardTitle>{text.matchesTitle}</CardTitle>
          <p className="text-sm text-gray-600 dark:text-gray-400">{requisition.canonicalSkillCount > 0 ? text.matchesHint : text.matchesTitleFallback}</p>
        </CardHeader>
        {matches.state === 'loading' ? <p className="text-sm text-gray-500">{t.common.loading}</p>
          : matches.state === 'failed' ? <p className="text-sm text-red-600 dark:text-red-400" role="alert">{text.matchesFailed}</p>
          : matches.data.length === 0 ? <p className="text-sm text-gray-600 dark:text-gray-400" data-testid="requisition-matches-empty">{text.matchesEmpty}</p>
          : <ul className="divide-y divide-gray-100 dark:divide-gray-800">
              {matches.data.map((m) => {
                const canAdd = !m.application || canTransition(m.application.stage, 'SHORTLISTED');
                return (
                  <li key={m.candidate.id} className="flex flex-wrap items-start justify-between gap-3 py-3" data-testid={`requisition-match-${m.candidate.id}`}>
                    <div className="min-w-0">
                      <Link href={`/admin/candidates/${m.candidate.id}`} className="font-medium text-blue-700 hover:underline dark:text-blue-300">{m.candidate.fullName}</Link>
                      <p className="text-xs text-gray-600 dark:text-gray-400">{[m.candidate.targetPosition, m.candidate.city].filter(Boolean).join(' · ')}</p>
                      <details className="mt-1" data-testid={`requisition-match-fit-${m.candidate.id}`}>
                        <summary className="cursor-pointer list-none">
                          <MatchScoreBreakdown compact score={m.fit.score} breakdown={m.fit.breakdown} blockedBy={[]} />
                        </summary>
                        <MatchScoreBreakdown className="mt-2" score={m.fit.score} breakdown={m.fit.breakdown} blockedBy={[]} />
                      </details>
                      <div className="mt-1 flex flex-wrap gap-1" data-testid={`requisition-match-reason-${m.candidate.id}`}>
                        {m.via === 'title'
                          ? <Badge variant="info">{text.matchedOnTitle}</Badge>
                          : <>
                              {m.direct.map((s) => <Badge key={s} variant="success">{s}</Badge>)}
                              {m.adjacent.map((x) => <Badge key={`${x.skill}-${x.via}`}>{text.relatedSkill.replace('{skill}', x.skill).replace('{via}', x.via)}</Badge>)}
                            </>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {m.application && <Badge variant="default">{text.inFunnel.replace('{stage}', stageLabel(m.application.stage))}</Badge>}
                      {canAdd && (
                        <Button size="sm" loading={busy === m.candidate.id} onClick={() => void shortlist(m.candidate.id)} data-testid={`requisition-shortlist-${m.candidate.id}`}>
                          {text.addToShortlist}
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>}
      </Card>
    </div>
  );
}

function BackLink({ label }: { label: string }) {
  return <Link href="/admin/requisitions" className="text-sm text-blue-600 dark:text-blue-400">← {label}</Link>;
}

function ApplicantRow({ applicant, stageLabel, busy, onRemove }: {
  applicant: Applicant;
  stageLabel: (stage: string) => string;
  busy: boolean;
  onRemove: (dispositionCode: string) => void;
}) {
  const t = useT();
  const text = t.requisitionDetail;
  const [reason, setReason] = useState('');
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-3" data-testid={`requisition-applicant-${applicant.mentee.id}`}>
      <div className="min-w-0">
        <Link href={`/admin/candidates/${applicant.mentee.id}`} className="font-medium text-blue-700 hover:underline dark:text-blue-300">{applicant.mentee.fullName}</Link>
        <div className="mt-1 flex flex-wrap gap-1">
          <Badge variant={applicant.stage === 'SHORTLISTED' ? 'success' : 'default'} data-testid={`requisition-applicant-stage-${applicant.mentee.id}`}>{stageLabel(applicant.stage)}</Badge>
          {applicant.source === 'ADMIN' && <Badge variant="info">{text.sourceAdmin}</Badge>}
          {applicant.matchedSkills.map((s) => <Badge key={s} variant="success">{s}</Badge>)}
        </div>
      </div>
      {applicant.stage === 'SHORTLISTED' && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-52">
            <Select aria-label={`${text.removeReason}: ${applicant.mentee.fullName}`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={text.removeReason}
              options={DISPOSITION_CODES.map((code) => ({ value: code, label: t.dispositionCodes[code] }))} data-testid={`requisition-remove-reason-${applicant.mentee.id}`} />
          </div>
          <Button size="sm" variant="outline" disabled={!reason} loading={busy} onClick={() => onRemove(reason)} data-testid={`requisition-remove-${applicant.mentee.id}`}>
            {text.removeFromShortlist}
          </Button>
        </div>
      )}
    </li>
  );
}
