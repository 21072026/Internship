'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { MapPin } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { useLocale, useT } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';
import { skillsOf, type PortalJob } from '@/lib/portalJobView';

// One open role on the mentee's job board (#1830). Anything not visible — a
// draft, a full role, another org's — reads as "not open any more" (the API
// answers 404). Applying is the next step (#1832); no dead button meanwhile.
export default function PortalJobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const t = useT();
  const J = t.portalJobs;
  const locale = useLocale();
  const [job, setJob] = useState<PortalJob | null | undefined>(undefined);

  useEffect(() => {
    fetch(`/api/portal/requisitions/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => setJob(body?.job ?? null))
      .catch(() => setJob(null));
  }, [id]);

  return (
    <div data-testid="portal-job-detail">
      <Link href="/portal/jobs" className="text-sm text-blue-700 dark:text-blue-300">← {J.back}</Link>
      {job === undefined ? (
        <p className="py-10 text-center text-gray-600 dark:text-gray-400" data-testid="page-loading">{t.common.loading}</p>
      ) : job === null ? (
        <p className="py-10 text-center text-gray-700 dark:text-gray-300" data-testid="portal-job-not-found">{J.notFound}</p>
      ) : (
        <div className="mt-4 space-y-5">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{job.title}</h1>
            <p className="mt-1 text-gray-700 dark:text-gray-300">{job.company.name}</p>
            <p className="mt-2 flex flex-wrap items-center gap-3 text-sm text-gray-600 dark:text-gray-400">
              {job.city && <span className="inline-flex items-center gap-1"><MapPin className="h-4 w-4" aria-hidden="true" />{job.city}</span>}
              {job.workMode && <span>{job.workMode}</span>}
              {job.startDate && <span>{J.starts.replace('{date}', formatDate(job.startDate, locale))}</span>}
            </p>
          </div>
          {job.description && <Card><p className="whitespace-pre-line text-sm text-gray-800 dark:text-gray-200">{job.description}</p></Card>}
          {skillsOf(job.requiredSkills).length > 0 && (
            <Card>
              <CardHeader><CardTitle>{J.skills}</CardTitle></CardHeader>
              <div className="flex flex-wrap gap-1">{skillsOf(job.requiredSkills).map((s) => <Badge key={s}>{s}</Badge>)}</div>
            </Card>
          )}
          {job.company.description && (
            <Card>
              <CardHeader><CardTitle>{J.about}</CardTitle></CardHeader>
              <p className="whitespace-pre-line text-sm text-gray-800 dark:text-gray-200">{job.company.description}</p>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
