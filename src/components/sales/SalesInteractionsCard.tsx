'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarClock, ChevronRight, GitCommitHorizontal, MessageSquare, Video } from 'lucide-react';
import { AddInteractionForm, type InteractionFormDraft } from '@/components/AddInteractionForm';
import { InteractionTypeBadge } from '@/components/InteractionTypeBadge';
import { useT } from '@/i18n/client';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { contentLang } from '@/lib/contentLanguage';
import { INTERACTION_DRAFT_EVENT, isTypingTarget, type InteractionDraftRequest } from './interactionDraft';

// The lead page's interactions (#3737/#3738): what already happened, next to
// the follow-up (what comes next) at the top of the page. The log form leads
// the card; the newest three entries follow, and "Show all" opens the rest the
// page already read. It replaces the separate one-line "Last interaction" box
// (#3653) — the newest entry is simply the first row here.
//
// The form opens pre-set from elsewhere on the page (interactionDraft.ts): the
// follow-up's "Complete" (#3740), the contact's phone/e-mail links (#3741) and
// the N key (#3742). Posting stays POST /api/interactions (owner-checked).
//
// A row is two lines (#3803): the type, the headline and how long ago on the
// first, the note — one line, clipped — on the second; a click opens the whole
// note. Rows are divided by a hairline, so one entry cannot run into the next.
// The distance is in calendar days (relativeDay): the form logs a day, the
// call prompt an instant, and "15 hours ago" would invent a time for the first.
//
// Earlier owners' periods (#3817): after a hand-off the lead page passes the
// interactions logged under the earlier records of the chain
// (src/lib/leadJourney.ts). Each period is its own section under the current
// list, collapsed by default and named by its owner and dates, so the earlier
// work is reachable without being re-attributed to the current owner. Whether
// they are open is remembered in this browser (a convenience, never relied on).
//
// Follow-up history (#3819): what happened to the follow-up — set, moved,
// completed, removed, handed over — joins the list as muted system lines
// (FollowUpEvent, src/lib/followUpEvents.ts). They are not interactions: they
// never count as a contact, and the page passes them only to viewers who may
// read the follow-up.
//
// Stage history and the filter (#3820): the record's stage moves (StatusChange,
// the audit row every move writes) are system lines too, and a segmented
// "All · Interactions · System" control above the list narrows it without
// splitting the chronology into tabs. All is the default; the choice is
// remembered in this browser (a convenience, never relied on). The control
// appears only once there is a system line to filter — and without it the
// remembered choice does not apply: a lead with no system line always reads
// All, or a "System" picked on another lead hid every interaction here with
// no control in sight to undo it (#3879).

export interface LeadInteraction {
  id: string;
  date: string;
  type: string;
  subject: string | null;
  notes: string;
}

/** A follow-up history line (#3819), already worded by the page in the viewer's language. */
export interface LeadSystemEvent {
  id: string;
  /** A follow-up line (#3819), a stage move read from StatusChange (#3820) or a meeting read from Meeting (#3837). */
  source: 'followUp' | 'stage' | 'meeting';
  at: string;
  headline: string;
  detail: string | null;
  by: string;
}

type Entry = { kind: 'interaction'; at: number; row: LeadInteraction } | { kind: 'system'; at: number; row: LeadSystemEvent };

export interface EarlierPeriodView {
  relationId: string;
  ownerName: string;
  from: string;
  to: string | null;
  interactions: LeadInteraction[];
  /** That period's follow-up history lines (#3870), when the viewer may read the follow-up. */
  events?: LeadSystemEvent[];
}

const FIRST_ROWS = 3;
const EARLIER_OPEN_KEY = 'sales.lead.earlierPeriodsOpen';

function readEarlierOpen(): boolean {
  try {
    return window.localStorage.getItem(EARLIER_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function writeEarlierOpen(open: boolean) {
  try {
    window.localStorage.setItem(EARLIER_OPEN_KEY, open ? '1' : '0');
  } catch {
    /* private window or blocked storage: the section simply starts collapsed */
  }
}

function InteractionRow({ row, open, onToggle }: { row: LeadInteraction; open: boolean; onToggle: () => void }) {
  // Without a subject the note is the headline, and there is no second line.
  const headline = row.subject || row.notes;
  const detail = row.subject ? row.notes : '';
  return (
    <li className="py-2 text-sm first:pt-0 last:pb-0" data-testid="sales-lead-interaction-row">
      <div className="flex min-w-0 items-center gap-2">
        <InteractionTypeBadge type={row.type} />
        <span lang={row.subject ? undefined : contentLang(row.notes)} className="min-w-0 flex-1 truncate font-medium text-gray-900 dark:text-gray-100" title={headline}>
          {headline}
        </span>
        <RelativeTime date={row.date} granularity="day" withTime className="shrink-0 text-xs text-gray-500 dark:text-gray-400" />
      </div>
      {detail && (
        <button
          type="button"
          lang={contentLang(detail)}
          onClick={onToggle}
          aria-expanded={open}
          title={open ? undefined : detail}
          className={`mt-0.5 block w-full text-left text-gray-600 dark:text-gray-300 ${open ? 'whitespace-pre-line break-words' : 'truncate'}`}
          data-testid="sales-lead-interaction-note"
        >
          {detail}
        </button>
      )}
    </li>
  );
}

// A system line is muted and says so: it records what happened to the
// follow-up, not a contact with the lead.
// One line (#3820): icon, what happened, the detail and who, then when. The
// whole text is the hover title, since a narrow card clips it.
function SystemRow({ row, badge }: { row: LeadSystemEvent; badge: string }) {
  const Icon = row.source === 'stage' ? GitCommitHorizontal : row.source === 'meeting' ? Video : CalendarClock;
  const text = [row.headline, row.detail, row.by].filter(Boolean).join(' · ');
  return (
    <li
      className="flex min-w-0 items-center gap-2 py-1.5 text-xs text-gray-500 first:pt-0 last:pb-0 dark:text-gray-400"
      data-testid="sales-lead-system-row"
      data-source={row.source}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-label={badge} />
      <span className="min-w-0 flex-1 truncate" title={text} data-testid="sales-lead-system-headline">
        {row.headline}
        {row.detail ? <span lang={contentLang(row.detail)}> · {row.detail}</span> : null}
        <span> · {row.by}</span>
      </span>
      <RelativeTime date={row.at} className="shrink-0" />
    </li>
  );
}

type Filter = 'all' | 'interactions' | 'system';
const FILTERS: readonly Filter[] = ['all', 'interactions', 'system'];
const FILTER_KEY = 'sales.lead.interactionFilter';

function readFilter(): Filter {
  try {
    const v = window.localStorage.getItem(FILTER_KEY);
    return (FILTERS as readonly string[]).includes(v ?? '') ? (v as Filter) : 'all';
  } catch {
    return 'all';
  }
}

function writeFilter(f: Filter) {
  try {
    window.localStorage.setItem(FILTER_KEY, f);
  } catch {
    /* private window or blocked storage: the filter simply starts at All */
  }
}

export function SalesInteractionsCard({
  relationId,
  canLog,
  interactions,
  systemEvents = [],
  earlierPeriods = [],
}: {
  relationId: string;
  canLog: boolean;
  interactions: LeadInteraction[];
  systemEvents?: LeadSystemEvent[];
  earlierPeriods?: EarlierPeriodView[];
}) {
  const t = useT();
  const s = t.sales.lead;
  const router = useRouter();
  const [showAll, setShowAll] = useState(false);
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (id: string) =>
    setOpened((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const [draft, setDraft] = useState<InteractionFormDraft | null>(null);
  // All on the server and on first paint; the remembered choice applies after hydration.
  const [remembered, setFilter] = useState<Filter>('all');
  useEffect(() => setFilter(readFilter()), []);
  const filter: Filter = systemEvents.length > 0 ? remembered : 'all';
  const pick = (f: Filter) => {
    setFilter(f);
    writeFilter(f);
  };
  // Collapsed on the server and on first paint; the remembered choice applies after hydration.
  const [earlierOpen, setEarlierOpen] = useState(false);
  useEffect(() => setEarlierOpen(readEarlierOpen()), []);
  const toggleEarlier = () =>
    setEarlierOpen((prev) => {
      writeEarlierOpen(!prev);
      return !prev;
    });

  useEffect(() => {
    if (!canLog) return;
    const open = (request: InteractionDraftRequest) => setDraft({ nonce: Date.now() + Math.random(), ...request });
    const onDraft = (e: Event) => open((e as CustomEvent<InteractionDraftRequest>).detail ?? {});
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'n' && e.key !== 'N') return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || isTypingTarget(e.target)) return;
      e.preventDefault();
      open({});
    };
    window.addEventListener(INTERACTION_DRAFT_EVENT, onDraft);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener(INTERACTION_DRAFT_EVENT, onDraft);
      window.removeEventListener('keydown', onKey);
    };
  }, [canLog]);

  // One timeline, newest first: the interactions and the follow-up's history lines.
  const entries: Entry[] = [
    ...interactions.map((row): Entry => ({ kind: 'interaction', at: Date.parse(row.date), row })),
    ...systemEvents.map((row): Entry => ({ kind: 'system', at: Date.parse(row.at), row })),
  ]
    .filter((e) => filter === 'all' || (filter === 'system') === (e.kind === 'system'))
    .sort((a, b) => b.at - a.at);
  const rows = showAll ? entries : entries.slice(0, FIRST_ROWS);
  const anything = interactions.length + systemEvents.length > 0;
  const f = s.interactionFilter;

  return (
    <div id="sales-lead-interactions-card" className="scroll-mt-20 rounded-lg border border-gray-200 p-3 dark:border-gray-700" data-testid="sales-lead-interactions-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-200">
          <MessageSquare className="h-4 w-4 text-gray-500 dark:text-gray-400" aria-hidden="true" />
          {s.interactions}
        </p>
        {canLog && (
          <span className="hidden text-xs text-gray-500 sm:inline dark:text-gray-400" data-testid="sales-lead-shortcut-hint">
            {s.shortcutBefore} <kbd className="rounded border border-gray-300 px-1 font-mono text-[11px] dark:border-gray-600">N</kbd> {s.shortcutAfter}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">{s.interactionsHint}</p>
      {canLog && (
        <div data-testid="sales-lead-log-interaction">
          <AddInteractionForm relationId={relationId} onAdded={() => router.refresh()} draft={draft} />
        </div>
      )}
      {systemEvents.length > 0 && (
        <div role="group" aria-label={f.label} className="mt-3 inline-flex rounded-md border border-gray-200 p-0.5 text-xs dark:border-gray-700" data-testid="sales-lead-interaction-filter">
          {FILTERS.map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => pick(key)}
              className={`rounded px-2 py-1 font-medium ${
                filter === key
                  ? 'bg-gray-800 text-white dark:bg-gray-200 dark:text-gray-900'
                  : 'text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100'
              }`}
              data-testid={`sales-lead-interaction-filter-${key}`}
            >
              {f[key]}
            </button>
          ))}
        </div>
      )}
      {entries.length === 0 ? (
        <p className="mt-3 text-sm text-gray-500" data-testid="sales-lead-interactions-empty">
          {anything ? f.empty : s.interactionsEmpty}
        </p>
      ) : (
        <>
          <ul className="mt-3 divide-y divide-gray-100 dark:divide-gray-800" data-testid="sales-lead-interactions">
            {rows.map((e) =>
              e.kind === 'system' ? (
                <SystemRow key={`s-${e.row.id}`} row={e.row} badge={s.followUpEvent.badge} />
              ) : (
                <InteractionRow key={e.row.id} row={e.row} open={opened.has(e.row.id)} onToggle={() => toggle(e.row.id)} />
              ),
            )}
          </ul>
          {entries.length > FIRST_ROWS && (
            <button
              type="button"
              className="mt-3 text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
              aria-expanded={showAll}
              onClick={() => setShowAll((v) => !v)}
              data-testid="sales-lead-interactions-toggle"
            >
              {showAll ? s.showFewer : s.showAll.replace('{n}', String(entries.length))}
            </button>
          )}
        </>
      )}
      {earlierPeriods.map((period) => (
        <section key={period.relationId} className="mt-3 border-t border-gray-100 pt-2 dark:border-gray-800" data-testid="sales-lead-earlier-period">
          <button
            type="button"
            className="flex w-full items-center gap-1 text-left text-xs font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
            aria-expanded={earlierOpen}
            onClick={toggleEarlier}
            data-testid="sales-lead-earlier-toggle"
          >
            <ChevronRight className={`h-3.5 w-3.5 shrink-0 transition-transform ${earlierOpen ? 'rotate-90' : ''}`} aria-hidden="true" />
            <span>
              {s.earlierPeriod
                .replace('{owner}', period.ownerName)
                .replace('{from}', period.from)
                .replace('{to}', period.to ?? '…')
                .replace('{n}', String(period.interactions.length))}
            </span>
          </button>
          {earlierOpen &&
            (period.interactions.length + (period.events?.length ?? 0) === 0 ? (
              <p className="mt-2 text-sm text-gray-500" data-testid="sales-lead-earlier-empty">{s.earlierPeriodEmpty}</p>
            ) : (
              <ul className="mt-2 divide-y divide-gray-100 opacity-90 dark:divide-gray-800" data-testid="sales-lead-earlier-interactions">
                {[
                  ...period.interactions.map((row): Entry => ({ kind: 'interaction', at: Date.parse(row.date), row })),
                  ...(period.events ?? []).map((row): Entry => ({ kind: 'system', at: Date.parse(row.at), row })),
                ]
                  .sort((a, b) => b.at - a.at)
                  .map((e) =>
                    e.kind === 'system' ? (
                      <SystemRow key={`s-${e.row.id}`} row={e.row} badge={s.followUpEvent.badge} />
                    ) : (
                      <InteractionRow key={e.row.id} row={e.row} open={opened.has(e.row.id)} onToggle={() => toggle(e.row.id)} />
                    ),
                  )}
              </ul>
            ))}
        </section>
      ))}
    </div>
  );
}
