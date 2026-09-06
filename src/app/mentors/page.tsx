'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { useT } from '@/i18n/client';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Users, AlertTriangle } from 'lucide-react';
import type { MentorAvailabilityStatus } from '@/lib/mentorAvailability';

interface DirectoryMentor {
  id: string;
  fullName: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  bio?: string | null;
  city?: string | null;
  country?: string | null;
  skills: string[];
  languages: string[];
  interests?: string | null;
  availabilityStatus: MentorAvailabilityStatus;
}

const AVAILABILITY_VARIANT: Record<MentorAvailabilityStatus, 'success' | 'warning' | 'default'> = {
  available: 'success',
  at_capacity: 'warning',
  not_accepting: 'default',
};

// Mentee-facing mentor directory (#938, story #900). Only mentors who opted in
// twice (publicProfile + MENTOR_DIRECTORY_VISIBILITY consent) appear — the API
// enforces that; this page just renders what it returns.
export default function MentorDirectoryPage() {
  const t = useT();
  // The "request this mentor" CTA (#1773) is a mentee-only shortcut into the
  // portal's request panel. MENTOR/ADMIN viewers browse the same directory but
  // cannot file a request (POST /api/mentorship-requests 403s them), so hiding
  // the button is cosmetic honesty — never the access control itself.
  const { data: session } = useSession();
  const isMentee = session?.user?.role === 'MENTEE';
  const [mentors, setMentors] = useState<DirectoryMentor[]>([]);
  const [total, setTotal] = useState(0);
  // The API says so explicitly when it could not scan the whole directory
  // (#1820) — a partial answer must never pretend to be a complete one.
  const [partial, setPartial] = useState(false);
  const [cap, setCap] = useState(0);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 12;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [skillFilter, setSkillFilter] = useState('');
  const [languageFilter, setLanguageFilter] = useState('');
  const [acceptingOnly, setAcceptingOnly] = useState(false);

  const hasFilters = Boolean(skillFilter || languageFilter || acceptingOnly);

  const availabilityLabel: Record<MentorAvailabilityStatus, string> = {
    available: t.mentorDirectory.accepting,
    at_capacity: t.mentorDirectory.atCapacity,
    not_accepting: t.mentorDirectory.notAccepting,
  };

  const fetchMentors = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (skillFilter) params.set('skill', skillFilter);
      if (languageFilter) params.set('language', languageFilter);
      if (acceptingOnly) params.set('accepting', '1');
      params.set('page', String(page));
      params.set('pageSize', String(PAGE_SIZE));
      const res = await fetch(`/api/mentors?${params}`);
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      setMentors(data.mentors || []);
      setTotal(typeof data.total === 'number' ? data.total : (data.mentors?.length ?? 0));
      setPartial(data.partial === true);
      setCap(typeof data.cap === 'number' ? data.cap : 0);
    } catch {
      setError(t.mentorDirectory.loadError);
    } finally {
      setLoading(false);
    }
  }, [skillFilter, languageFilter, acceptingOnly, page, t]);

  useEffect(() => {
    const timeout = setTimeout(fetchMentors, 300);
    return () => clearTimeout(timeout);
  }, [fetchMentors]);

  // Any filter change returns to page 1.
  useEffect(() => {
    setPage(1);
  }, [skillFilter, languageFilter, acceptingOnly]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.mentorDirectory.title}</h1>
        <p className="text-gray-500 mt-1">{t.mentorDirectory.subtitle}</p>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* Filters */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 mb-6">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-center">
          <Input
            data-testid="mentors-filter-skill"
            aria-label={t.mentorDirectory.filterSkill}
            placeholder={t.mentorDirectory.filterSkillPlaceholder}
            value={skillFilter}
            onChange={(e) => setSkillFilter(e.target.value)}
          />
          <Input
            data-testid="mentors-filter-language"
            aria-label={t.mentorDirectory.filterLanguage}
            placeholder={t.mentorDirectory.filterLanguagePlaceholder}
            value={languageFilter}
            onChange={(e) => setLanguageFilter(e.target.value)}
          />
          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              data-testid="mentors-filter-accepting"
              checked={acceptingOnly}
              onChange={(e) => setAcceptingOnly(e.target.checked)}
            />
            {t.mentorDirectory.acceptingOnly}
          </label>
        </div>
      </div>

      {/* The result set was capped before filtering — say so rather than
          quietly under-reporting (#1820). */}
      {!loading && partial && (
        <div
          data-testid="mentors-partial-notice"
          className="mb-4 flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800"
        >
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>{t.mentorDirectory.partialNotice.replace('{cap}', String(cap))}</span>
        </div>
      )}

      {/* Mentor cards */}
      {loading ? (
        <Card><SkeletonRows rows={6} /></Card>
      ) : mentors.length === 0 ? (
        <Card>
          <EmptyState
            testId="mentor-directory"
            icon={Users}
            title={hasFilters ? t.mentorDirectory.noMatches : t.mentorDirectory.empty}
          />
        </Card>
      ) : (
        <>
        <p data-testid="mentors-total" className="mb-3 text-sm text-gray-600 dark:text-gray-300">
          {t.mentorDirectory.showing
            .replace('{from}', String(from))
            .replace('{to}', String(to))
            .replace('{total}', String(total))}
        </p>
        <div data-testid="mentors-list" className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {mentors.map((mentor) => {
            const name = mentor.displayName || mentor.fullName;
            return (
              <Card key={mentor.id} data-testid={`mentor-card-${mentor.id}`} className="flex flex-col">
                <div className="flex items-start gap-3 mb-3">
                  {mentor.avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={mentor.avatarUrl}
                      alt={name}
                      className="w-12 h-12 rounded-full object-cover border border-gray-200 dark:border-gray-700 flex-shrink-0"
                    />
                  ) : (
                    <div className="w-12 h-12 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center flex-shrink-0">
                      <span className="font-semibold">{name?.[0] || '?'}</span>
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-gray-900 dark:text-gray-100 break-words">{name}</p>
                    {(mentor.city || mentor.country) && (
                      <p className="text-sm text-gray-500 break-words">
                        {[mentor.city, mentor.country].filter(Boolean).join(', ')}
                      </p>
                    )}
                  </div>
                  <Badge variant={AVAILABILITY_VARIANT[mentor.availabilityStatus]} className="flex-shrink-0">
                    {availabilityLabel[mentor.availabilityStatus]}
                  </Badge>
                </div>

                {mentor.bio && (
                  <p className="text-sm text-gray-600 dark:text-gray-300 line-clamp-2 mb-3">{mentor.bio}</p>
                )}

                {mentor.skills.length > 0 && (
                  <div className="mb-3">
                    <p className="text-xs font-medium text-gray-500 mb-1">{t.mentorDirectory.skillsLabel}</p>
                    <div className="flex flex-wrap gap-1">
                      {mentor.skills.map((skill) => (
                        <Badge key={skill} variant="info" className="text-xs">
                          {skill}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {mentor.languages.length > 0 && (
                  <p className="text-xs text-gray-600 dark:text-gray-300 mb-3">
                    <span className="font-medium text-gray-500">{t.mentorDirectory.languagesLabel}:</span>{' '}
                    {mentor.languages.join(', ')}
                  </p>
                )}

                <div className="mt-auto flex flex-wrap items-center gap-3 pt-2">
                  <Link
                    href={`/p/${mentor.id}`}
                    className="text-sm text-blue-600 dark:text-blue-300 hover:underline"
                  >
                    {t.mentorDirectory.viewProfile}
                  </Link>
                  {isMentee && (
                    /* A styled Link, not a <Button> inside a <Link>: nested
                       interactive elements are an axe violation (a11y-scan). */
                    <Link
                      href={`/portal?mentor=${mentor.id}`}
                      data-testid={`mentor-request-${mentor.id}`}
                      className="ml-auto inline-flex min-h-11 items-center rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
                    >
                      {t.mentorDirectory.requestMentor}
                    </Link>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
        </>
      )}

      {!loading && totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 mt-8">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            {t.common.prev}
          </Button>
          <span className="text-sm text-gray-500">{page} / {totalPages}</span>
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
            {t.common.next}
          </Button>
        </div>
      )}
    </div>
  );
}
