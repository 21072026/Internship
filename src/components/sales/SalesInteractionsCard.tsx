'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MessageSquare } from 'lucide-react';
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

export interface LeadInteraction {
  id: string;
  date: string;
  type: string;
  subject: string | null;
  notes: string;
}

const FIRST_ROWS = 3;

export function SalesInteractionsCard({ relationId, canLog, interactions }: { relationId: string; canLog: boolean; interactions: LeadInteraction[] }) {
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

  const rows = showAll ? interactions : interactions.slice(0, FIRST_ROWS);

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
      {interactions.length === 0 ? (
        <p className="mt-3 text-sm text-gray-500" data-testid="sales-lead-interactions-empty">{s.interactionsEmpty}</p>
      ) : (
        <>
          <ul className="mt-3 divide-y divide-gray-100 dark:divide-gray-800" data-testid="sales-lead-interactions">
            {rows.map((i) => {
              // Without a subject the note is the headline, and there is no second line.
              const headline = i.subject || i.notes;
              const detail = i.subject ? i.notes : '';
              const open = opened.has(i.id);
              return (
                <li key={i.id} className="py-2 text-sm first:pt-0 last:pb-0" data-testid="sales-lead-interaction-row">
                  <div className="flex min-w-0 items-center gap-2">
                    <InteractionTypeBadge type={i.type} />
                    <span lang={i.subject ? undefined : contentLang(i.notes)} className="min-w-0 flex-1 truncate font-medium text-gray-900 dark:text-gray-100" title={headline}>
                      {headline}
                    </span>
                    <RelativeTime date={i.date} granularity="day" className="shrink-0 text-xs text-gray-500 dark:text-gray-400" />
                  </div>
                  {detail && (
                    <button
                      type="button"
                      lang={contentLang(detail)}
                      onClick={() => toggle(i.id)}
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
            })}
          </ul>
          {interactions.length > FIRST_ROWS && (
            <button
              type="button"
              className="mt-3 text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
              aria-expanded={showAll}
              onClick={() => setShowAll((v) => !v)}
              data-testid="sales-lead-interactions-toggle"
            >
              {showAll ? s.showFewer : s.showAll.replace('{n}', String(interactions.length))}
            </button>
          )}
        </>
      )}
    </div>
  );
}
