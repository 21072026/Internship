'use client';

import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { AiBadge } from '@/components/AiBadge';
import { useT } from '@/i18n/client';
import { formatMentorAvailability } from '@/lib/mentorAvailabilityLabel';
import type { MentorAvailability } from '@/lib/mentorAvailability';

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
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [aiUsed, setAiUsed] = useState(false);
  // Assignment held for confirmation (#942) when the picked mentor's server-
  // reported availability.status is at_capacity/not_accepting — never
  // recomputed on the client, just read off the mentor object the caller
  // already fetched from /api/users?view=mentorAvailability.
  const [pendingAssign, setPendingAssign] = useState<{ mentorId: string; status: 'at_capacity' | 'not_accepting' } | null>(null);

  // Mentor suggestion (#533): rule-based ranking, AI-deepened with a rationale
  // when the AI gate allows — otherwise the top rule-based match, no rationale.
  const suggest = async () => {
    setSuggesting(true);
    setErr('');
    try {
      const res = await fetch('/api/admin/mentor-suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ menteeId }),
      });
      if (res.ok) {
        const d = await res.json();
        const top = (d.suggestions ?? [])[0] ?? null;
        setSuggestion(top);
        setAiUsed(!!d.aiUsed);
        if (top) setChoice(top.mentorId);
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
        <p className="text-xs text-gray-600 dark:text-gray-300 mt-1.5" data-testid="mentor-suggestion">
          <span className="font-medium">{a.suggested}: {suggestion.fullName}</span>
          {suggestion.reason
            ? ` — ${suggestion.reason}`
            : suggestion.sharedSkills.length > 0
              ? ` — ${a.sharedSkills}: ${suggestion.sharedSkills.join(', ')}`
              : ''}
          {/* The rationale sentence is the only model-written text on this
              screen — badge it, and only it (#2034). The rule-based order
              carries its own "(rule based)" note instead. */}
          {aiUsed && suggestion.reason && <AiBadge className="ml-1.5" />}
          {!aiUsed && <span className="text-gray-400"> ({a.ruleBased})</span>}
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
