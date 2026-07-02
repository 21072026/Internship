'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Users, Star } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { pipelineLabel } from '@/lib/pipeline';
import { useT, useLocale } from '@/i18n/client';

interface MentorRelation {
  id: string;
  status: string;
  pipelineStatus: string;
  mentee: { id: string; fullName: string; email: string };
  company: { name: string } | null;
  evaluations: { scores: Record<string, number> }[];
}
interface MentorDetail {
  id: string;
  fullName: string;
  email: string;
  department?: string;
  skills: string[];
  mentorCapacity?: number | null;
  mentorRelations: MentorRelation[];
}

export default function AdminMentorDetailPage() {
  const id = useParams().id as string;
  const t = useT();
  const locale = useLocale();
  const [user, setUser] = useState<MentorDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await fetch(`/api/users/${id}`);
    const data = await res.json();
    setUser(data.user ?? null);
    setLoading(false);
  }, [id]);
  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="text-center py-12 text-gray-400">{t.common.loading}</div>;
  if (!user) return <div className="text-center py-12 text-gray-400">{t.common.notFound}</div>;

  const relations = user.mentorRelations ?? [];
  const active = relations.filter((r) => r.status === 'ACTIVE');
  const cap = user.mentorCapacity;
  const atCapacity = cap != null && cap > 0 && active.length >= cap;

  // Average of every numeric evaluation score across this mentor's relations.
  const scoreValues = relations
    .flatMap((r) => r.evaluations)
    .flatMap((e) => Object.values(e.scores ?? {}))
    .filter((v): v is number => typeof v === 'number' && !isNaN(v));
  const avg = scoreValues.length ? scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length : null;

  return (
    <div>
      <div className="mb-6">
        <Link href="/admin/mentors" className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 mb-4">
          <ArrowLeft className="h-4 w-4" />
          {t.mentorDetail.back}
        </Link>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{user.fullName}</h1>
            <p className="text-gray-500">{user.email}{user.department ? ` · ${user.department}` : ''}</p>
          </div>
          <Badge variant={atCapacity ? 'warning' : 'info'} className="flex items-center gap-1 flex-shrink-0">
            <Users className="h-3 w-3" />
            {active.length}{cap != null ? `/${cap}` : ''} {t.mentors.mentee}
          </Badge>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card>
          <CardHeader><CardTitle>{t.mentorDetail.profile}</CardTitle></CardHeader>
          <div className="space-y-3">
            <div>
              <p className="text-xs text-gray-500 mb-1">{t.mentors.expertise}</p>
              {user.skills.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {user.skills.map((s) => <Badge key={s} variant="info" className="text-xs">{s}</Badge>)}
                </div>
              ) : (
                <p className="text-xs text-amber-600">{t.mentors.noExpertise}</p>
              )}
            </div>
            <div>
              <p className="text-xs text-gray-500">{t.mentors.capacity}</p>
              <p className="text-sm text-gray-900 dark:text-gray-100">{cap != null ? cap : t.mentors.unlimited}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 flex items-center gap-1"><Star className="h-3 w-3" /> {t.mentorDetail.avgRating}</p>
              <p className="text-sm text-gray-900 dark:text-gray-100">{avg != null ? `${avg.toFixed(1)} / 5` : t.mentorDetail.noRatings}</p>
            </div>
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>{t.mentorDetail.activeMentees} ({active.length})</CardTitle></CardHeader>
          {active.length === 0 ? (
            <p className="text-sm text-gray-400 py-6 text-center">{t.mentorDetail.noMentees}</p>
          ) : (
            <div className="divide-y divide-gray-50 dark:divide-gray-800">
              {active.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <Link href={`/admin/candidates/${r.mentee.id}`} className="text-sm font-medium text-gray-900 dark:text-gray-100 hover:text-blue-600 truncate block">
                      {r.mentee.fullName}
                    </Link>
                    <p className="text-xs text-gray-500 truncate">
                      {r.mentee.email}{r.company ? ` · ${r.company.name}` : ''}
                    </p>
                  </div>
                  <Badge variant="default" className="flex-shrink-0">{pipelineLabel(r.pipelineStatus, locale)}</Badge>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
