'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MessageSquare } from 'lucide-react';
import { AddInteractionForm, type InteractionFormDraft } from '@/components/AddInteractionForm';
import { InteractionTypeBadge } from '@/components/InteractionTypeBadge';
import { useLocale, useT } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';
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
  const locale = useLocale();
  const router = useRouter();
  const [showAll, setShowAll] = useState(false);
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
          <ul className="mt-3 space-y-3" data-testid="sales-lead-interactions">
            {rows.map((i) => (
              <li key={i.id} className="text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <InteractionTypeBadge type={i.type} />
                  <span className="text-gray-500">{formatDate(i.date, locale)}</span>
                </div>
                {i.subject && <p className="mt-1 font-medium text-gray-900 dark:text-gray-100">{i.subject}</p>}
                <p lang={contentLang(i.notes)} className="mt-0.5 line-clamp-2 text-gray-600 dark:text-gray-300">{i.notes}</p>
              </li>
            ))}
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
