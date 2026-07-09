'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

interface MentorOption {
  id: string;
  fullName: string;
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

  const assign = async (mentorId: string) => {
    if (!mentorId) return;
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
            <option key={m.id} value={m.id}>{m.fullName}</option>
          ))}
        </select>
        <Button size="sm" variant="outline" loading={busy} disabled={!choice} onClick={() => assign(choice)}>
          {a.assign}
        </Button>
      </div>
      {err && <p className="text-xs text-red-600 mt-1.5">{err}</p>}
    </div>
  );
}
