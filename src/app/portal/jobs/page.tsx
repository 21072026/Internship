'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { BriefcaseBusiness, MapPin } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { useLocale, useT } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';
import { skillsOf, type PortalJob } from '@/lib/portalJobView';

// The mentee's job board (#1830): the open roles of the programme's employers,
// from GET /api/portal/requisitions — search and filters run on the server,
// the total is the server's count.

const PAGE_SIZE = 20;
type Filters = { q: string; city: string; workMode: string; skill: string };
const EMPTY: Filters = { q: '', city: '', workMode: '', skill: '' };

export default function PortalJobsPage() {
  const t = useT();
  const J = t.portalJobs;
  const locale = useLocale();
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ jobs: PortalJob[]; total: number } | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)), page: String(page), pageSize: String(PAGE_SIZE) });
    try {
      const res = await fetch(`/api/portal/requisitions?${qs}`);
      if (!res.ok) throw new Error(String(res.status));
      setData(await res.json());
      setFailed(false);
    } catch {
      setFailed(true);
      setData({ jobs: [], total: 0 });
    }
  }, [filters, page]);
  useEffect(() => { void load(); }, [load]);

  const submit = (e: FormEvent) => { e.preventDefault(); setPage(1); setFilters(draft); };
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div data-testid="portal-jobs">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{J.title}</h1>
        <p className="mt-1 text-gray-600 dark:text-gray-400">{J.subtitle}</p>
        <Link href="/portal/applications" className="mt-2 inline-block text-sm font-medium text-blue-700 hover:underline dark:text-blue-300" data-testid="portal-jobs-my-applications">{J.viewApplications}</Link>
      </div>

      <form onSubmit={submit} className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <Input type="search" aria-label={J.search} placeholder={J.search} value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} data-testid="portal-jobs-search" />
        </div>
        <Input aria-label={J.city} placeholder={J.city} value={draft.city} onChange={(e) => setDraft({ ...draft, city: e.target.value })} data-testid="portal-jobs-city" />
        <Input aria-label={J.workMode} placeholder={J.workMode} value={draft.workMode} onChange={(e) => setDraft({ ...draft, workMode: e.target.value })} data-testid="portal-jobs-work-mode" />
        <Input aria-label={J.skill} placeholder={J.skill} value={draft.skill} onChange={(e) => setDraft({ ...draft, skill: e.target.value })} data-testid="portal-jobs-skill" />
        <div className="flex gap-2 lg:col-span-5">
          <Button type="submit" data-testid="portal-jobs-apply">{J.apply}</Button>
          <Button type="button" variant="outline" onClick={() => { setDraft(EMPTY); setFilters(EMPTY); setPage(1); }}>{J.reset}</Button>
        </div>
      </form>

      {failed && <p className="mb-3 text-sm text-red-600 dark:text-red-400" role="alert">{J.loadFailed}</p>}
      {!data ? (
        <p className="py-10 text-center text-gray-600 dark:text-gray-400" data-testid="page-loading">{t.common.loading}</p>
      ) : data.jobs.length === 0 ? (
        <EmptyState testId="portal-jobs-empty" icon={BriefcaseBusiness} title={J.empty} body={J.emptyHint} />
      ) : (
        <>
          <p className="mb-3 text-sm text-gray-600 dark:text-gray-400" data-testid="portal-jobs-count">{J.count.replace('{n}', String(data.total))}</p>
          <ul className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {data.jobs.map((job) => {
              const left = Math.max(0, job.openings - job.filled);
              return (
                <li key={job.id} data-testid={`job-card-${job.id}`}>
                  <Card className="h-full">
                    <Link href={`/portal/jobs/${job.id}`} className="block space-y-2">
                      <p className="text-lg font-semibold text-blue-700 hover:underline dark:text-blue-300">{job.title}</p>
                      <p className="text-sm text-gray-700 dark:text-gray-300">{job.company.name}</p>
                      <p className="flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                        {job.city && <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" aria-hidden="true" />{job.city}</span>}
                        {job.workMode && <span>{job.workMode}</span>}
                        {job.startDate && <span>{J.starts.replace('{date}', formatDate(job.startDate, locale))}</span>}
                        <span>{left === 1 ? J.seatLeftOne : J.seatsLeft.replace('{n}', String(left))}</span>
                      </p>
                      {skillsOf(job.requiredSkills).length > 0 && (
                        <div className="flex flex-wrap gap-1">{skillsOf(job.requiredSkills).slice(0, 8).map((s) => <Badge key={s}>{s}</Badge>)}</div>
                      )}
                    </Link>
                  </Card>
                </li>
              );
            })}
          </ul>
          {pages > 1 && (
            <div className="mt-5 flex items-center justify-between">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>{J.previous}</Button>
              <span className="text-sm text-gray-600 dark:text-gray-400">{J.page.replace('{page}', String(page)).replace('{total}', String(pages))}</span>
              <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>{J.next}</Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
