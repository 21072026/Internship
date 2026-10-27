'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Briefcase } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { fillTemplate } from '@/components/ui/fillTemplate';
import { useT, useLocale } from '@/i18n/client';
import { formatDateTimeWithZone } from '@/lib/relativeTime';
import { viewerTimeZone } from '@/lib/timezone';

// The "Hiring" card of the admin candidate page (#1398): every company that
// wants this candidate, for which role, where each application stands, and
// each interview request — read from GET /api/candidates/[id]/hiring, which
// scopes the rows on the server. Loading, empty and failed are three different
// states (#891/#932: an empty list while the request is in flight reads as
// "nothing is happening with this person").

type Ref = { id: string; title: string } | null;
type Company = { id: string; name: string };
type ApplicationRow = { id: string; stage: string; source: string; dispositionCode: string | null; updatedAt: string; requisition: Ref & { status?: string }; company: Company };
type InterestRow = { id: string; status: string; note?: string | null; updatedAt: string; company: Company; requisition: Ref };
type InterviewRow = {
  id: string; status: string; scheduledAt: string | null; decidedAt: string | null; createdAt: string;
  declineReasonCode: string | null; cancelReason: string | null; proposedSlots: unknown;
  company: Company; requisition: Ref; decidedBy: { id: string; fullName: string } | null;
};
type Data = { applications: ApplicationRow[]; interests: InterestRow[]; interviewRequests: InterviewRow[] };

const INTEREST_VARIANT: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = { INTERESTED: 'info', SHORTLISTED: 'success', PASS: 'default' };

export function CandidateHiringPanel({ candidateId }: { candidateId: string }) {
  const t = useT();
  const text = t.candidateHiring;
  const locale = useLocale();
  // 'hidden': the org's vertical has no placements module (a MARKETING sales
  // book) — the route answers capability_unavailable and the card is not drawn.
  const [state, setState] = useState<'loading' | 'failed' | 'ready' | 'hidden'>('loading');
  const [data, setData] = useState<Data>({ applications: [], interests: [], interviewRequests: [] });

  useEffect(() => {
    let live = true;
    setState('loading');
    fetch(`/api/candidates/${candidateId}/hiring`)
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!live) return;
        if (r.ok && body) { setData(body as Data); setState('ready'); }
        else setState(body?.code === 'capability_unavailable' ? 'hidden' : 'failed');
      })
      .catch(() => { if (live) setState('failed'); });
    return () => { live = false; };
  }, [candidateId]);

  const stageLabel = (s: string) => (t.requisitionPipeline.stages as Record<string, string>)[s] ?? s;
  const irLabel = (s: string) => (t.interviewRequests.statuses as Record<string, string>)[s] ?? s;
  const reqLink = (r: Ref) => (r ? <Link href={`/admin/requisitions/${r.id}`} className="font-medium text-blue-700 hover:underline dark:text-blue-300">{r.title}</Link> : <span className="text-gray-600 dark:text-gray-400">{text.noRequisition}</span>);
  if (state === 'hidden') return null;
  const empty = data.applications.length === 0 && data.interests.length === 0 && data.interviewRequests.length === 0;

  return (
    <Card data-testid="candidate-hiring">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>{text.title}</CardTitle>
          <Link href="/admin/interview-requests" className="text-sm text-blue-700 hover:underline dark:text-blue-300">{text.queueLink}</Link>
        </div>
      </CardHeader>
      {state === 'loading' ? (
        <p className="text-sm text-gray-500" data-testid="candidate-hiring-loading">{t.common.loading}</p>
      ) : state === 'failed' ? (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert" data-testid="candidate-hiring-failed">{text.loadFailed}</p>
      ) : empty ? (
        <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400" data-testid="candidate-hiring-empty">
          <Briefcase className="h-4 w-4" aria-hidden="true" />{text.empty}
        </div>
      ) : (
        <div className="space-y-5 text-sm">
          {data.applications.length > 0 && (
            <section aria-labelledby="hiring-applications">
              <h3 id="hiring-applications" className="mb-2 font-semibold text-gray-900 dark:text-gray-100">{text.applications}</h3>
              <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                {data.applications.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid={`candidate-hiring-application-${a.id}`}>
                    <div className="min-w-0">{reqLink(a.requisition)}<span className="text-gray-600 dark:text-gray-400"> · {a.company.name}</span></div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={a.stage === 'HIRED' ? 'success' : a.stage === 'REJECTED' || a.stage === 'WITHDRAWN' ? 'default' : 'info'}>{stageLabel(a.stage)}</Badge>
                      {a.dispositionCode && <span className="text-xs text-gray-600 dark:text-gray-400">{(t.dispositionCodes as Record<string, string>)[a.dispositionCode] ?? a.dispositionCode}</span>}
                      {a.source === 'ADMIN' && <Badge>{t.requisitionDetail.sourceAdmin}</Badge>}
                      <span className="text-xs text-gray-600 dark:text-gray-400"><RelativeTime date={a.updatedAt} locale={locale} /></span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {data.interests.length > 0 && (
            <section aria-labelledby="hiring-interests">
              <h3 id="hiring-interests" className="mb-2 font-semibold text-gray-900 dark:text-gray-100">{text.interests}</h3>
              <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                {data.interests.map((i) => (
                  <li key={i.id} className="py-2" data-testid={`candidate-hiring-interest-${i.id}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0"><span className="font-medium text-gray-900 dark:text-gray-100">{i.company.name}</span><span className="text-gray-600 dark:text-gray-400"> · </span>{reqLink(i.requisition)}</div>
                      <div className="flex items-center gap-2">
                        <Badge variant={INTEREST_VARIANT[i.status] ?? 'default'}>{(text.interestStatuses as Record<string, string>)[i.status] ?? i.status}</Badge>
                        <span className="text-xs text-gray-600 dark:text-gray-400"><RelativeTime date={i.updatedAt} locale={locale} /></span>
                      </div>
                    </div>
                    {i.note && <p className="mt-1 whitespace-pre-line text-gray-700 dark:text-gray-300">{i.note}</p>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {data.interviewRequests.length > 0 && (
            <section aria-labelledby="hiring-interviews">
              <h3 id="hiring-interviews" className="mb-2 font-semibold text-gray-900 dark:text-gray-100">{text.interviews}</h3>
              <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                {data.interviewRequests.map((r) => {
                  const slots = Array.isArray(r.proposedSlots) ? (r.proposedSlots as unknown[]).filter((s): s is string => typeof s === 'string') : [];
                  return (
                    <li key={r.id} className="py-2" data-testid={`candidate-hiring-interview-${r.id}`}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0"><span className="font-medium text-gray-900 dark:text-gray-100">{r.company.name}</span><span className="text-gray-600 dark:text-gray-400"> · </span>{reqLink(r.requisition)}</div>
                        <Badge variant={r.status === 'SCHEDULED' || r.status === 'APPROVED' ? 'success' : r.status === 'PENDING' ? 'warning' : 'default'}>{irLabel(r.status)}</Badge>
                      </div>
                      <div className="mt-1 space-y-0.5 text-xs text-gray-600 dark:text-gray-400">
                        <p>{fillTemplate(text.requested, { when: <RelativeTime date={r.createdAt} locale={locale} /> })}</p>
                        {r.status === 'SCHEDULED' && r.scheduledAt && <p className="font-medium text-gray-900 dark:text-gray-100">{t.interviewRequests.scheduledAt.replace('{when}', formatDateTimeWithZone(r.scheduledAt, locale, viewerTimeZone(null)))}</p>}
                        {r.status === 'PENDING' && slots.length > 0 && <p>{text.proposedSlots}: {slots.map((s) => formatDateTimeWithZone(s, locale, viewerTimeZone(null))).join(' · ')}</p>}
                        {r.decidedBy && r.decidedAt && <p>{fillTemplate(text.decidedBy, { name: r.decidedBy.fullName, when: <RelativeTime date={r.decidedAt} locale={locale} /> })}</p>}
                        {r.status === 'CANCELLED' && r.cancelReason && <p>{t.interviewRequests.cancelledWithReason.replace('{reason}', r.cancelReason)}</p>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>
      )}
    </Card>
  );
}
