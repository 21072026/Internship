'use client';

import { useCallback, useEffect, useState } from 'react';
import { Inbox, Check, X } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useT, useLocale } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';
import { PersonHoverCard } from '@/components/PersonHoverCard';

// The mentor's application inbox (#1188): public /apply submissions wait here
// as pending requests until the mentor accepts (relation starts) or declines
// (the applicant is told politely — never silence). Loading ≠ empty (#891).

interface PendingApplication {
  id: string;
  message: string | null;
  createdAt: string;
  mentee: { id: string; fullName: string; university: string | null; department: string | null; city: string | null; skills: unknown };
}

export default function MentorApplicationsPage() {
  const t = useT();
  const locale = useLocale();
  const [requests, setRequests] = useState<PendingApplication[] | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch('/api/mentor/applications')
      .then((r) => (r.ok ? r.json() : { requests: [] }))
      .then((d) => setRequests(d.requests ?? []))
      .catch(() => setRequests([]));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const decide = async (id: string, action: 'accept' | 'reject') => {
    setDeciding(id);
    setFlash(null);
    try {
      const res = await fetch('/api/mentor/applications', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: id, action }),
      });
      if (res.ok) {
        setRequests((prev) => (prev ?? []).filter((r) => r.id !== id));
        setFlash(action === 'accept' ? t.mentorApplications.accepted : t.mentorApplications.rejected);
      } else {
        const d = await res.json().catch(() => ({}));
        setFlash(d.error ?? t.common.error);
      }
    } finally {
      setDeciding(null);
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.mentorApplications.title}</h1>
        <p className="text-gray-500 mt-1">{t.mentorApplications.subtitle}</p>
      </div>

      {flash && <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700">{flash}</div>}

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Inbox className="h-5 w-5 text-blue-600" />
            <CardTitle>{t.mentorApplications.pending}</CardTitle>
          </div>
        </CardHeader>
        {requests === null ? (
          <p className="py-4 text-sm text-gray-400">{t.common.loading}</p>
        ) : requests.length === 0 ? (
          <p className="py-4 text-sm text-gray-500" data-testid="mentor-applications-empty">{t.mentorApplications.empty}</p>
        ) : (
          <ul className="space-y-3">
            {requests.map((r) => (
              <li key={r.id} className="rounded-xl border border-gray-100 dark:border-gray-800 p-4" data-testid={`mentor-application-${r.id}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-900 dark:text-gray-100">
                      <PersonHoverCard personId={r.mentee.id} name={r.mentee.fullName} role="MENTEE" />
                    </p>
                    <p className="text-sm text-gray-500">
                      {[r.mentee.university, r.mentee.department, r.mentee.city].filter(Boolean).join(' · ')}
                    </p>
                    {Array.isArray(r.mentee.skills) && r.mentee.skills.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {(r.mentee.skills as string[]).slice(0, 8).map((s) => (
                          <span key={s} className="rounded bg-blue-50 px-1.5 py-0.5 text-[11px] text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                            {s}
                          </span>
                        ))}
                      </div>
                    )}
                    <p className="mt-1 text-xs text-gray-400">{formatDate(r.createdAt, locale)}</p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" loading={deciding === r.id} onClick={() => decide(r.id, 'accept')} data-testid={`application-accept-${r.id}`}>
                      <Check className="h-4 w-4" />
                      {t.mentorApplications.accept}
                    </Button>
                    <Button size="sm" variant="outline" loading={deciding === r.id} onClick={() => decide(r.id, 'reject')} data-testid={`application-reject-${r.id}`}>
                      <X className="h-4 w-4" />
                      {t.mentorApplications.reject}
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
