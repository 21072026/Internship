'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  CalendarClock,
  ExternalLink,
  FileText,
  History,
  Lock,
  MessageSquare,
  Target,
  Handshake,
} from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { AsyncSection } from '@/components/ui/AsyncSection';
import { InteractionTypeBadge } from '@/components/InteractionTypeBadge';
import { useT, useLocale } from '@/i18n/client';
import { useStageLabel } from '@/lib/pipelineStagesClient';
import { formatDate, formatDateTime, relativeTime } from '@/lib/relativeTime';
import type { TimelineEntry, TimelineKind } from '@/lib/relationTimeline';

// The merged history of one pairing (#1702). Presentational only: the ordering,
// the merge across six tables and the per-role redaction all happen once on the
// server (lib/relationTimeline.ts), so this component never has to decide what
// a mentee is allowed to read — it renders whatever the endpoint returned.

const ICONS: Record<TimelineKind, typeof History> = {
  stage: ArrowRight,
  interaction: MessageSquare,
  meeting: CalendarClock,
  goal: Target,
  report: FileText,
  offer: Handshake,
  note: Lock,
};

// bg-*-100 chips stay light in dark mode (globals.css retints only bg-*-50), so
// each non-gray icon pill pins its own dark pair. The gray one deliberately has
// none: `html.dark .bg-gray-100` / `.text-gray-700` are flat overrides at
// specificity (0,2,1) and OUTRANK any `dark:` variant written beside them
// (#2131) — the same reason no gray text below carries a `dark:text-*`.
const ICON_TONES: Record<TimelineKind, string> = {
  stage: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  interaction: 'bg-gray-100 text-gray-700',
  meeting: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  goal: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  report: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  offer: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
  note: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
};

interface TimelineResponse {
  entries: TimelineEntry[];
  nextCursor: string | null;
  kinds: TimelineKind[];
}

export function RelationTimeline({ relationId }: { relationId: string }) {
  const t = useT();
  const locale = useLocale();
  const stageLabel = useStageLabel();

  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [kinds, setKinds] = useState<TimelineKind[]>([]);
  const [filter, setFilter] = useState<TimelineKind | 'all'>('all');
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A failed *pagination* request must not take the panel over: AsyncSection
  // renders its error box INSTEAD of its children, so putting a load-more
  // failure in `error` would blank the pages already on screen. Two slots: the
  // initial load owns the panel, the next page owns one line under the button.
  const [moreError, setMoreError] = useState<string | null>(null);
  // Monotonic request id. Two loads can be in flight after a fast filter
  // switch and nothing orders their responses, so a late one must not write
  // the list (or the cursor) the newer one already owns.
  const requestRef = useRef(0);

  // One request per (relation, filter). The cursor is a PARAMETER, never read
  // from state inside: a callback that closed over it would keep whatever
  // `cursor` was when it was last created — null at mount — and every
  // "load older" click would re-fetch page 1 and append it to itself.
  // `fromCursor === null` means "first page", which is also what a retry does.
  const load = useCallback(
    async (fromCursor: string | null) => {
      const more = fromCursor !== null;
      const requestId = ++requestRef.current;
      if (more) {
        setLoadingMore(true);
        setMoreError(null);
      } else {
        setLoading(true);
        setError(null);
        setMoreError(null);
      }
      try {
        const qs = new URLSearchParams();
        if (filter !== 'all') qs.set('kinds', filter);
        if (fromCursor) qs.set('cursor', fromCursor);
        const res = await fetch(`/api/mentorship/${relationId}/timeline?${qs.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: TimelineResponse = await res.json();
        if (requestId !== requestRef.current) return; // superseded mid-flight
        setEntries((prev) => (more ? [...prev, ...(data.entries ?? [])] : data.entries ?? []));
        setCursor(data.nextCursor ?? null);
        if (data.kinds?.length) setKinds(data.kinds);
      } catch {
        if (requestId !== requestRef.current) return;
        if (more) setMoreError(t.relationTimeline.error);
        else {
          setEntries([]);
          setError(t.relationTimeline.error);
        }
      } finally {
        // The newer request owns the spinners; clearing them here would flash
        // the loaded state while it is still running.
        if (requestId === requestRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [relationId, filter, t]
  );

  useEffect(() => {
    setCursor(null);
    load(null);
  }, [load]);

  const chips = useMemo<(TimelineKind | 'all')[]>(() => ['all', ...kinds], [kinds]);

  return (
    <Card data-testid="relation-timeline">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="h-5 w-5 text-gray-400" aria-hidden="true" />
          {t.relationTimeline.title}
        </CardTitle>
        <p className="mt-1 text-sm text-gray-500">{t.relationTimeline.description}</p>
      </CardHeader>

      {chips.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-1.5" role="group" aria-label={t.relationTimeline.filterLabel}>
          {chips.map((chip) => {
            const active = filter === chip;
            return (
              <button
                key={chip}
                type="button"
                data-testid={`timeline-filter-${chip}`}
                aria-pressed={active}
                onClick={() => setFilter(chip)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                  active
                    ? 'border-blue-600 bg-blue-600 text-white'
                    : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                {chip === 'all' ? t.relationTimeline.filterAll : t.relationTimeline.kind[chip]}
              </button>
            );
          })}
        </div>
      )}

      <AsyncSection
        loading={loading}
        error={error}
        empty={entries.length === 0}
        emptyText={
          <p className="text-sm text-gray-500" data-testid="timeline-empty">
            {filter === 'all' ? t.relationTimeline.empty : t.relationTimeline.emptyFiltered}
          </p>
        }
        retryText={t.relationTimeline.retry}
        onRetry={() => load(null)}
      >
        <ol className="space-y-3">
          {entries.map((entry) => (
            <TimelineRow key={entry.id} entry={entry} locale={locale} t={t} stageLabel={stageLabel} />
          ))}
        </ol>

        <div className="mt-4 flex flex-col items-center gap-2">
          {moreError && (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400" data-testid="timeline-more-error">
              {moreError}
            </p>
          )}
          {cursor ? (
            <Button variant="outline" size="sm" loading={loadingMore} onClick={() => load(cursor)} data-testid="timeline-load-more">
              {t.relationTimeline.loadMore}
            </Button>
          ) : (
            // Never a silent truncation: when the last page is in, the panel
            // says so, so "12 rows" can't be mistaken for a hidden cap.
            <p className="text-xs text-gray-400" data-testid="timeline-end">
              {t.relationTimeline.end}
            </p>
          )}
        </div>
      </AsyncSection>
    </Card>
  );
}

function TimelineRow({
  entry,
  locale,
  t,
  stageLabel,
}: {
  entry: TimelineEntry;
  locale: string;
  t: ReturnType<typeof useT>;
  stageLabel: (key: string) => string;
}) {
  const Icon = ICONS[entry.kind] ?? History;
  const events = t.relationTimeline.event as Record<string, string | undefined>;
  const heading = events[entry.event] ?? t.relationTimeline.kind[entry.kind];
  const roles = t.relationTimeline.actorRole as Record<string, string | undefined>;
  const reportStatus = t.weeklyReports.status as Record<string, string | undefined>;
  const dropoffReasons = t.dropoff.reasons as Record<string, string | undefined>;
  // A named person and a bare role need different templates: German contracts
  // "von dem Mentor" to "vom Mentor", so the role forms carry their own
  // preposition and `byRole` is the identity template there.
  const roleActor = entry.actor ? null : entry.actorRole ? roles[entry.actorRole] ?? null : null;
  const byline = entry.actor
    ? t.relationTimeline.by.replace('{name}', entry.actor)
    : roleActor
      ? t.relationTimeline.byRole.replace('{role}', roleActor)
      : null;

  return (
    <li
      className="flex gap-3"
      data-testid="timeline-entry"
      data-entry-id={entry.id}
      data-kind={entry.kind}
      data-event={entry.event}
    >
      <span
        className={`mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full ${ICON_TONES[entry.kind]}`}
        aria-hidden="true"
      >
        <Icon className="h-4 w-4" />
      </span>

      <div className="min-w-0 flex-1 border-b border-gray-100 pb-3 last:border-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-gray-900">{heading}</span>

          {entry.kind === 'stage' && entry.toStage && (
            <span className="text-sm text-gray-600">
              <span className="text-gray-400">{entry.fromStage ? stageLabel(entry.fromStage) : '—'}</span>
              {' → '}
              <span className="font-medium">{stageLabel(entry.toStage)}</span>
            </span>
          )}

          {entry.kind === 'interaction' && entry.status && (
            <InteractionTypeBadge type={entry.status} className="text-[10px]" />
          )}

          {/* Two statuses earn a badge: a weekly report's review state, and the
              drop-off reason on a stage move (admin/mentor only — the endpoint
              strips it for the mentee). Every other kind says it in the heading
              ("Goal completed", "Offer declined"), so a raw enum chip beside it
              would be noise, and an untranslated one at that. */}
          {entry.kind === 'report' && entry.status && (
            <Badge variant="default" className="text-[10px]">
              {reportStatus[entry.status] ?? entry.status}
            </Badge>
          )}

          {entry.kind === 'stage' && entry.status && (
            <Badge variant="warning" className="text-[10px]">
              {dropoffReasons[entry.status] ?? entry.status}
            </Badge>
          )}

          {entry.automatic && (
            <Badge variant="info" className="text-[10px]">{t.relationTimeline.automatic}</Badge>
          )}

          <time
            className="ml-auto flex-shrink-0 text-[11px] text-gray-400"
            dateTime={entry.at}
            title={formatDateTime(entry.at, locale)}
          >
            {relativeTime(entry.at, locale)}
          </time>
        </div>

        {/* The week a report covers is shipped as an ISO instant and formatted
            here, so it reads in the app's locale date format like every other
            date on the row — not as a bare "2026-09-01" next to "01.09.2026". */}
        {entry.kind === 'report' && entry.weekStart && (
          <p className="mt-0.5 truncate text-sm text-gray-700">
            {t.relationTimeline.weekOf.replace('{date}', formatDate(entry.weekStart, locale))}
          </p>
        )}
        {entry.title && <p className="mt-0.5 truncate text-sm text-gray-700">{entry.title}</p>}
        {entry.detail && <p className="mt-0.5 text-xs text-gray-500">{entry.detail}</p>}

        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-gray-400">
          <span>{formatDateTime(entry.at, locale)}</span>
          {byline && <span>· {byline}</span>}
          {entry.href && (
            <a
              href={entry.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-blue-600 hover:underline dark:text-blue-400"
            >
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
              {t.relationTimeline.openLink}
            </a>
          )}
        </p>
      </div>
    </li>
  );
}
