'use client';
import { useT } from "@/i18n/client";

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Card } from '@/components/ui/Card';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Users, MessageSquare, Search } from 'lucide-react';
import Link from 'next/link';
import { ApplyLinkBox } from '@/components/ApplyLinkBox';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { StartMeetingButton } from '@/components/meeting/StartMeetingButton';
import { PersonHoverCard } from '@/components/PersonHoverCard';
import { StageClockChip } from '@/components/StageClockChip';
import { SavedViews } from '@/components/SavedViews';
import { useResolvedStages } from '@/lib/pipelineStagesClient';
import { useFilterAnnouncement } from '@/hooks/useFilterAnnouncement';
import {
  EMPTY_MENTEE_FILTERS,
  MENTEE_STATUS_FILTERS,
  filterMenteeRows,
  hasActiveMenteeFilters,
  type MenteeFilters,
  type MenteeStatusFilter,
} from '@/lib/menteeFilter';

interface MentorshipRelation {
  id: string;
  status: string;
  startDate: string;
  // The stage clock (#1724) — same two fields the board card reads.
  pipelineStatus: string;
  stageDeadline: string | null;
  daysInStage?: number | null;
  stageClockPaused?: boolean;
  // Stamped by the daily sweep (#1508) when the mentee is still parked at first
  // contact, was messaged and never answered. Null for everybody else.
  dormantSince: string | null;
  dormantNudgeCount: number;
  mentee: {
    id: string;
    fullName: string;
    email: string;
    university?: string;
    department?: string;
    graduationYear?: number;
    skills: string[];
    phone?: string;
    cvUrl?: string;
  };
  company: { id: string; name: string; industry?: string } | null;
  _count: { interactions: number };
}

export default function MenteesPage() {
  const t = useT();
  const [relations, setRelations] = useState<MentorshipRelation[]>([]);
  const [loading, setLoading] = useState(true);
  // Dormant mentees are hidden by default — that is the point of flagging them.
  // The toggle is always one click away, and it counts them, so "where did they
  // go?" is answered on the screen rather than in a support message.
  const [showDormant, setShowDormant] = useState(false);
  // Search + status + stage, all client-side over the full list this page
  // already loads (GET /api/mentorship only paginates for callers that ask for
  // a page, and this one never does). See src/lib/menteeFilter.ts for why the
  // matching itself lives outside this component.
  const [filters, setFilters] = useState<MenteeFilters>(EMPTY_MENTEE_FILTERS);
  const stages = useResolvedStages();

  const fetchRelations = useCallback(async () => {
    const res = await fetch('/api/mentorship');
    const data = await res.json();
    setRelations(data.relations || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchRelations();
  }, [fetchRelations]);

  const dormantCount = relations.filter((rel) => rel.dormantSince).length;
  // Dormant first (that toggle is about who belongs on the screen at all), then
  // the mentor's own filters — so the dormant count keeps counting everyone.
  const visibleRelations = useMemo(
    () =>
      filterMenteeRows(
        showDormant ? relations : relations.filter((rel) => !rel.dormantSince),
        filters,
      ),
    [relations, showDormant, filters],
  );
  const filtering = hasActiveMenteeFilters(filters);

  // WCAG 4.1.3: typing rewrites the grid in place and moves no focus, so a
  // screen-reader user is told how many rows survived (debounced by the hook).
  useFilterAnnouncement(
    filtering
      ? visibleRelations.length === 0
        ? t.a11y.noResultsShown
        : visibleRelations.length === 1
          ? t.a11y.resultsShownOne
          : t.a11y.resultsShown.replace('{count}', String(visibleRelations.length))
      : null,
  );

  return (
    <div>
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.mentor.myMentees}</h1>
          <p className="text-gray-500 mt-1">{t.mentor.menteesSubtitle}</p>
        </div>
        <Link href="/mentor/mentees/new">
          <Button>
            <Users className="h-4 w-4" />
            {t.mentor.addMentee}
          </Button>
        </Link>
      </div>

      <ApplyLinkBox />

      {dormantCount > 0 && (
        <div className="mb-4">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowDormant((v) => !v)}
            data-testid="toggle-dormant-mentees"
          >
            {showDormant ? t.mentor.dormantHide : t.mentor.dormantShow.replace('{n}', String(dormantCount))}
          </Button>
        </div>
      )}

      {!loading && relations.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-3" data-testid="mentee-filter-bar">
            {MENTEE_STATUS_FILTERS.map((sf) => (
              <button
                key={sf}
                onClick={() => setFilters((f) => ({ ...f, status: sf }))}
                aria-pressed={filters.status === sf}
                data-testid={`mentee-status-filter-${sf}`}
                className={`min-h-11 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  filters.status === sf
                    ? 'bg-blue-600 text-white'
                    : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
                }`}
              >
                {sf === 'ALL' ? t.usersAdmin.all : sf === 'ACTIVE' ? t.mentorships.active : t.mentorships.completed}
              </button>
            ))}
            {/* The org's OWN stages (#747) — never the canonical enum. */}
            <select
              data-testid="mentee-stage-filter"
              aria-label={t.mentor.menteeStageFilter}
              value={filters.stage}
              onChange={(e) => setFilters((f) => ({ ...f, stage: e.target.value }))}
              className="min-h-11 rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
            >
              <option value="">{t.mentor.menteeAllStages}</option>
              {stages.map((stage) => (
                <option key={stage.key} value={stage.key}>{stage.label}</option>
              ))}
            </select>
            <div className="relative ml-auto w-full sm:w-72">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                type="search"
                data-testid="mentee-search"
                aria-label={t.mentor.menteeSearchPlaceholder}
                value={filters.search}
                onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
                placeholder={t.mentor.menteeSearchPlaceholder}
                className="min-h-11 w-full rounded-lg border border-gray-300 pl-9 pr-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
              />
            </div>
          </div>
          <div className="mb-4">
            <SavedViews
              storageKey="mentor-mentees-views"
              current={{ search: filters.search, status: filters.status, stage: filters.stage }}
              onApply={(f) =>
                setFilters({
                  search: f.search || '',
                  status: (MENTEE_STATUS_FILTERS as readonly string[]).includes(f.status)
                    ? (f.status as MenteeStatusFilter)
                    : 'ALL',
                  // A saved view can name a stage the org has since renamed or
                  // removed; keeping it would filter the grid down to nothing
                  // with no visible cause, so an unknown key falls back to all.
                  stage: stages.some((stage) => stage.key === f.stage) ? f.stage : '',
                })
              }
            />
          </div>
        </>
      )}

      {loading ? (
        <Card><SkeletonRows rows={6} /></Card>
      ) : visibleRelations.length === 0 && filtering ? (
        /* Filtered to nothing — a different situation from "no mentees yet", and
           the way out is clearing the filter, not adding a mentee. */
        <Card>
          <EmptyState
            testId="mentor-mentees-no-match"
            icon={Search}
            title={t.mentor.noMatchingMentees}
            body={t.mentor.noMatchingMenteesHint}
            action={{ label: t.mentor.clearMenteeFilters, onClick: () => setFilters(EMPTY_MENTEE_FILTERS) }}
          />
        </Card>
      ) : visibleRelations.length === 0 ? (
        <Card>
          <EmptyState
            testId="mentor-mentees"
            icon={Users}
            title={t.mentor.noMenteesAssigned}
            body={t.mentor.noMenteesHint}
            action={{ label: t.mentor.addMentee, href: '/mentor/mentees/new' }}
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6" data-testid="mentee-list">
          {visibleRelations.map((rel) => (
            <Card key={rel.id} data-testid={`mentee-card-${rel.id}`}>
              <div className="flex items-start justify-between gap-2 mb-4">
                {/* `min-w-0` + `truncate`: a long address ran out of the card,
                    because the text block would not shrink next to the status
                    badge (#1305). The name is a hover-card trigger (#1302); the
                    truncation stays on the heading so the link inherits it. */}
                <div className="min-w-0">
                  <h3 className="font-semibold text-gray-900 text-lg truncate">
                    <PersonHoverCard personId={rel.mentee.id} name={rel.mentee.fullName} role="MENTEE" />
                  </h3>
                  <p className="text-sm text-gray-500 truncate">{rel.mentee.email}</p>
                </div>
                <div className="flex flex-shrink-0 flex-col items-end gap-1">
                  <StatusBadge status={rel.status} />
                  <StageClockChip
                    testId={`stage-clock-${rel.id}`}
                    daysInStage={rel.daysInStage}
                    stageDeadline={rel.stageDeadline}
                    pipelineStatus={rel.pipelineStatus}
                    relationStatus={rel.status}
                    paused={rel.stageClockPaused}
                  />
                  {rel.dormantSince && (
                    <Badge variant="default" title={t.mentor.dormantTitle} data-testid={`dormant-badge-${rel.id}`}>
                      {t.mentor.dormantBadge}
                    </Badge>
                  )}
                </div>
              </div>

              <div className="space-y-2 mb-4">
                {rel.mentee.university && (
                  <p className="text-sm text-gray-600">🎓 {rel.mentee.university} · {rel.mentee.department}</p>
                )}
                {rel.mentee.graduationYear && (
                  <p className="text-sm text-gray-600">📅 {t.candidates.classOf} {rel.mentee.graduationYear}</p>
                )}
                {rel.mentee.phone && (
                  <p className="text-sm text-gray-600">📞 {rel.mentee.phone}</p>
                )}
                {rel.company && (
                  <p className="text-sm text-blue-600">🏢 {rel.company.name}</p>
                )}
              </div>

              {rel.mentee.skills.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-4">
                  {rel.mentee.skills.map((skill) => (
                    <Badge key={skill} variant="info" className="text-xs">{skill}</Badge>
                  ))}
                </div>
              )}

              {/* Wraps on a phone: interaction count + three actions did not fit a
                  360px card, so "Detayları gör" was clipped at the card edge (#1305). */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Badge variant="default">{rel._count.interactions} {t.mentor.interactions}</Badge>
                {rel.dormantSince && rel.dormantNudgeCount > 0 && (
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {t.mentor.dormantNudges.replace('{n}', String(rel.dormantNudgeCount))}
                  </span>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <StartMeetingButton
                    target={{ relationIds: [rel.id] }}
                    defaultTitle={t.meetings.instant.defaultWith.replace('{name}', rel.mentee.fullName)}
                    testId={`start-meeting-${rel.id}`}
                  />
                  {/* Icon-only: the row already carries two buttons, and writing to
                      a mentee should not cost a detour through the detail page. */}
                  <Link href={`/messages/${rel.id}`} data-testid={`message-mentee-${rel.id}`}>
                    <Button size="sm" variant="outline" aria-label={t.messages.sendMessage} title={t.messages.sendMessage}>
                      <MessageSquare className="h-4 w-4" />
                    </Button>
                  </Link>
                  <Link href={`/mentor/mentees/${rel.id}`}>
                    <Button size="sm" variant="outline">{t.mentor.viewDetails}</Button>
                  </Link>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
