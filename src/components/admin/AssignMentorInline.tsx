'use client';

import { useId, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { AiBadge } from '@/components/AiBadge';
import { useT } from '@/i18n/client';
import { formatMentorAvailability } from '@/lib/mentorAvailabilityLabel';
import type { MentorAvailability } from '@/lib/mentorAvailability';
import { MATCH_DISMISS_REASONS, type MatchDismissReason } from '@/lib/matchFeedback';

interface MentorOption {
  id: string;
  fullName: string;
  // Capacity/availability (#942) — optional so callers that only have a bare
  // {id, fullName} picker (no /api/users?view=mentorAvailability fetch) still
  // satisfy this type; the label is simply omitted for those.
  mentorCapacity?: number | null;
  activeMenteeCount?: number;
  availability?: MentorAvailability;
}

interface Suggestion {
  mentorId: string;
  fullName: string;
  sharedSkills: string[];
  reason: string | null;
}

// Inline "assign a mentor" control shown on an unassigned candidate card, so an
// admin can bind the candidate to themselves or to another mentor without
// leaving the Candidates screen. Calls POST /api/mentorship.
export function AssignMentorInline({
  menteeId,
  mentors,
  meId,
  onAssigned,
}: {
  menteeId: string;
  mentors: MentorOption[];
  meId?: string | null;
  onAssigned: () => void;
}) {
  const t = useT();
  const a = t.assignMentor;
  const f = t.matchFeedback;
  // /admin/candidates renders this component TWICE per candidate (a md:hidden
  // mobile card and a desktop one), so a menteeId-derived id would be a
  // duplicate in the document. useId is per-instance.
  const reasonSelectId = useId();
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  // The whole ranked list, not just the winner (#2040). One is on screen at a
  // time, but dismissing #1 has to reveal #2 — otherwise ranks 2-5 are recorded
  // as "shown" while nobody could ever pick them, and the per-rank report is a
  // fiction.
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [cursor, setCursor] = useState(0);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [aiUsed, setAiUsed] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  // The dismiss reason picker, open only after the ✕ is clicked.
  const [dismissing, setDismissing] = useState(false);
  const [dismissReason, setDismissReason] = useState<MatchDismissReason>(MATCH_DISMISS_REASONS[0]);
  // Assignment held for confirmation (#942) when the picked mentor's server-
  // reported availability.status is at_capacity/not_accepting — never
  // recomputed on the client, just read off the mentor object the caller
  // already fetched from /api/users?view=mentorAvailability.
  const [pendingAssign, setPendingAssign] = useState<{ mentorId: string; status: 'at_capacity' | 'not_accepting' } | null>(null);

  const suggestion = suggestions[cursor] ?? null;

  // Record what happened to a suggestion (#2040). Always best-effort: this is
  // bookkeeping, and losing a row must never cost the admin their assignment.
  const recordFeedback = async (
    mentorId: string,
    action: 'ACCEPTED' | 'DISMISSED',
    reason?: MatchDismissReason
  ): Promise<void> => {
    if (!batchId) return; // no suggestions were shown — nothing to report on
    try {
      await fetch('/api/admin/mentor-suggest/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId, mentorId, action, reason }),
      });
    } catch {
      /* ignore */
    }
  };

  // Mentor suggestion (#533): rule-based ranking, AI-deepened with a rationale
  // when the AI gate allows — otherwise the top rule-based match, no rationale.
  const suggest = async () => {
    setSuggesting(true);
    setErr('');
    setExhausted(false);
    setDismissing(false);
    try {
      const res = await fetch('/api/admin/mentor-suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ menteeId }),
      });
      if (res.ok) {
        const d = await res.json();
        const list: Suggestion[] = d.suggestions ?? [];
        setSuggestions(list);
        setCursor(0);
        setBatchId(d.batchId ?? null);
        setAiUsed(!!d.aiUsed);
        if (list[0]) setChoice(list[0].mentorId);
        else setErr(a.noSuggestion);
      } else {
        setErr(t.common.error);
      }
    } catch {
      setErr(t.common.error);
    } finally {
      setSuggesting(false);
    }
  };

  // ✕ on the suggestion card: record why, then reveal the next-best mentor.
  const confirmDismiss = async () => {
    if (!suggestion) return;
    const next = cursor + 1;
    await recordFeedback(suggestion.mentorId, 'DISMISSED', dismissReason);
    setDismissing(false);
    setDismissReason(MATCH_DISMISS_REASONS[0]);
    if (next < suggestions.length) {
      setCursor(next);
      setChoice(suggestions[next].mentorId);
    } else {
      setCursor(next);
      setExhausted(true);
      setChoice('');
    }
  };

  // Does the actual POST — called either directly (available mentor) or after
  // the confirmation dialog is accepted (at_capacity/not_accepting). The
  // response's `warnings` (#942) are accepted defensively and otherwise
  // ignored here: the confirmation already happened client-side before this
  // ran, so a second dialog off the same warning would just be a duplicate.
  const doAssign = async (mentorId: string) => {
    setBusy(true);
    setErr('');
    try {
      const res = await fetch('/api/mentorship', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mentorId, menteeId }),
      });
      if (res.ok) {
        // Report the acceptance before the parent re-renders this card away.
        // The server decides whether this mentor was one of ours — an
        // off-list assignment is recorded too, and stays distinguishable.
        await recordFeedback(mentorId, 'ACCEPTED');
        onAssigned();
        return;
      }
      const d = await res.json().catch(() => ({}));
      setErr(res.status === 409 ? a.alreadyAssigned : d.error || t.common.error);
    } catch {
      setErr(t.common.error);
    } finally {
      setBusy(false);
    }
  };

  // Entry point for both "Assign to me" and the dropdown "Assign" button.
  // Gates on the mentor's own availability.status from the server — never
  // recomputed here — and only interrupts with a dialog for at_capacity/
  // not_accepting; an available mentor (or one with no availability info at
  // all) is assigned immediately, same as before #942.
  const assign = (mentorId: string) => {
    if (!mentorId) return;
    const status = mentors.find((m) => m.id === mentorId)?.availability?.status;
    if (status === 'at_capacity' || status === 'not_accepting') {
      setPendingAssign({ mentorId, status });
      return;
    }
    doAssign(mentorId);
  };

  const confirmAssign = () => {
    if (!pendingAssign) return;
    const { mentorId } = pendingAssign;
    setPendingAssign(null);
    doAssign(mentorId);
  };

  // Other mentors (exclude self — self is the dedicated button).
  const others = mentors.filter((m) => m.id !== meId);

  return (
    <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
      <p className="text-xs font-medium text-gray-500 mb-1.5">{a.label}</p>
      <div className="flex flex-wrap items-center gap-2">
        {meId && (
          <Button size="sm" loading={busy} onClick={() => assign(meId)}>
            {a.assignToMe}
          </Button>
        )}
        <select
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          disabled={busy}
          aria-label={a.chooseMentor}
          className="flex-1 min-w-[8rem] rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-2.5 py-1.5 text-sm"
        >
          <option value="">{a.chooseMentor}</option>
          {others.map((m) => (
            <option key={m.id} value={m.id}>
              {/* Full or paused mentors stay selectable (#942) — the label is
                  advisory, never a restriction. */}
              {m.availability
                ? `${m.fullName} · ${formatMentorAvailability(
                    { mentorCapacity: m.mentorCapacity ?? null, activeMenteeCount: m.activeMenteeCount ?? 0, availability: m.availability },
                    t.mentorAvailability
                  )}`
                : m.fullName}
            </option>
          ))}
        </select>
        <Button size="sm" variant="outline" loading={busy} disabled={!choice} onClick={() => assign(choice)}>
          {a.assign}
        </Button>
        <Button size="sm" variant="ghost" loading={suggesting} onClick={suggest} title={a.suggestHint} data-testid="suggest-mentor">
          <Sparkles className="h-4 w-4" />
        </Button>
      </div>
      {suggestion && (
        <div className="mt-1.5 flex items-start gap-1.5" data-testid="mentor-suggestion">
          <p className="text-xs text-gray-600 dark:text-gray-300 flex-1 min-w-0">
            <span className="font-medium">{a.suggested}: {suggestion.fullName}</span>
            {suggestion.reason
              ? ` — ${suggestion.reason}`
              : suggestion.sharedSkills.length > 0
                ? ` — ${a.sharedSkills}: ${suggestion.sharedSkills.join(', ')}`
                : ''}
            {aiUsed && suggestion.reason && <AiBadge className="ml-1.5" />}
            {!aiUsed && <span className="text-gray-400"> ({a.ruleBased})</span>}
          </p>
          <button
            type="button"
            onClick={() => setDismissing((v) => !v)}
            aria-label={f.dismiss}
            title={f.dismiss}
            data-testid="dismiss-suggestion"
            className="flex-shrink-0 rounded p-0.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {suggestion && dismissing && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2" data-testid="dismiss-reason-picker">
          <label className="text-xs text-gray-500" htmlFor={reasonSelectId}>
            {f.dismissTitle}
          </label>
          <select
            id={reasonSelectId}
            data-testid="dismiss-reason-select"
            value={dismissReason}
            onChange={(e) => setDismissReason(e.target.value as MatchDismissReason)}
            className="rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-2 py-1 text-xs"
          >
            {MATCH_DISMISS_REASONS.map((code) => (
              <option key={code} value={code}>
                {f.reasons[code]}
              </option>
            ))}
          </select>
          <Button size="sm" variant="outline" onClick={confirmDismiss} data-testid="dismiss-confirm">
            {f.dismissConfirm}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDismissing(false)}>
            {t.common.cancel}
          </Button>
        </div>
      )}
      {exhausted && (
        <p className="text-xs text-gray-400 mt-1.5" data-testid="suggestions-exhausted">
          {f.noMore}
        </p>
      )}
      {err && <p className="text-xs text-red-600 mt-1.5">{err}</p>}
      <ConfirmDialog
        open={pendingAssign !== null}
        message={pendingAssign?.status === 'at_capacity' ? a.confirmAtCapacity : a.confirmNotAccepting}
        cancelLabel={t.common.cancel}
        confirmLabel={a.confirmAnyway}
        loading={busy}
        onConfirm={confirmAssign}
        onCancel={() => setPendingAssign(null)}
      />
    </div>
  );
}
