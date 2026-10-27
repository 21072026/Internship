'use client';

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import { useT } from '@/i18n/client';
import { AvailabilityEditor } from '@/components/availability/AvailabilityEditor';

interface MentorOption { id: string; fullName: string }

// A mentor's hours, run by the admin without impersonating them (#2005). No
// new API: the picker is the org's active mentors, and the editor calls the
// same endpoints the mentor's own page does with `mentorId`, which already
// accept an ADMIN for a mentor of their own organization — another org's
// mentor answers 404, exactly as before.
export default function AdminAvailabilityPage() {
  const t = useT();
  const a = t.adminAvailability;
  const [mentors, setMentors] = useState<MentorOption[] | null>(null);
  const [mentorId, setMentorId] = useState('');

  useEffect(() => {
    fetch('/api/users?view=picker&status=active&role=MENTOR')
      .then((res) => (res.ok ? res.json() : { users: [] }))
      .then((d) => {
        const list: MentorOption[] = (d.users ?? []).sort((x: MentorOption, y: MentorOption) => x.fullName.localeCompare(y.fullName));
        setMentors(list);
        // A deep link (?mentorId=) opens on that mentor when they are in the list.
        const wanted = new URLSearchParams(window.location.search).get('mentorId');
        if (wanted && list.some((m) => m.id === wanted)) setMentorId(wanted);
      })
      .catch(() => setMentors([]));
  }, []);

  const pick = (id: string) => {
    setMentorId(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('mentorId', id);
    else url.searchParams.delete('mentorId');
    window.history.replaceState(null, '', url);
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{a.adminTitle}</h1>
        <p className="text-gray-500 mt-1">{a.adminSubtitle}</p>
      </div>

      <Card className="mb-6 max-w-md">
        {mentors && mentors.length === 0 ? (
          <p data-testid="admin-availability-no-mentors" className="text-sm text-gray-500">{a.noMentors}</p>
        ) : (
          <Select
            label={a.pickMentor}
            value={mentorId}
            onChange={(e) => pick(e.target.value)}
            disabled={!mentors}
            data-testid="admin-availability-mentor"
            options={[{ value: '', label: a.pickMentorPlaceholder }, ...(mentors ?? []).map((m) => ({ value: m.id, label: m.fullName }))]}
          />
        )}
      </Card>

      {mentorId ? (
        // Keyed by the mentor, so switching starts from a clean form instead of
        // carrying one mentor's half-typed slot over to the next.
        <AvailabilityEditor key={mentorId} mentorId={mentorId} />
      ) : (
        mentors && mentors.length > 0 && <p className="text-sm text-gray-400">{a.pickMentorPrompt}</p>
      )}
    </div>
  );
}
