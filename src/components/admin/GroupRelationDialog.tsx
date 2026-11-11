'use client';

import { useState } from 'react';
import { useT } from '@/i18n/client';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { useModalFocus } from '@/components/ui/useModalFocus';
import { GROUP_MAX_MENTEES } from '@/lib/relationShapes';
import { useFilterAnnouncement, resultCountMessage } from '@/hooks/useFilterAnnouncement';
import { usePeopleSearch } from '@/components/ui/PersonPicker';
import { fillTemplate } from '@/components/ui/fillTemplate';
import { PICKER_MAX_LIMIT, PICKER_ROLES } from '@/lib/userPickerQuery';

interface Person {
  id: string;
  fullName: string;
}

/**
 * Form a GROUP (#1804): one mentor, 2…25 mentees, one relation. The server
 * decides every refusal (bench, eligibility, one active mentor); this only
 * collects the choice and shows the code it answers with.
 */
export function GroupRelationDialog({ mentors, onCreated }: { mentors: Person[]; onCreated: () => void }) {
  const t = useT();
  const g = t.relationGroups;
  const [open, setOpen] = useState(false);
  const [mentorId, setMentorId] = useState('');
  // Picked people by id, with their names: a pick stays listed (and nameable in
  // a refusal) after the search moves on to other people.
  const [picked, setPicked] = useState<Person[]>([]);
  const [filter, setFilter] = useState('');
  // The mentee list is searched on the server, one bounded page at a time
  // (#1437) — the dialog used to be handed the tenant's whole user list.
  const found = usePeopleSearch(filter, { roles: PICKER_ROLES, limit: PICKER_MAX_LIMIT, enabled: open });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const ref = useModalFocus<HTMLDivElement>(open, () => setOpen(false));

  const isPicked = (id: string) => picked.some((p) => p.id === id);
  const toggle = (person: Person) =>
    setPicked((p) => (p.some((x) => x.id === person.id) ? p.filter((x) => x.id !== person.id) : [...p, { id: person.id, fullName: person.fullName }]));
  const shown = found.people.filter((m) => m.id !== mentorId && !isPicked(m.id));
  // Picks first, then the page of matches that are not picked yet.
  const rows: Person[] = [...picked.filter((p) => p.id !== mentorId), ...shown];
  // A screen reader hears how many mentees the filter left (WCAG 4.1.3).
  useFilterAnnouncement(open && filter.trim() !== '' ? resultCountMessage(t.a11y, shown.length) : null);

  async function submit() {
    setError('');
    if (!mentorId || picked.length < 2) {
      setError(g.errors.too_few);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/admin/relations/group', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mentorId, menteeIds: picked.map((p) => p.id) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const name = picked.find((m) => m.id === body.menteeId || m.id === body.userId)?.fullName;
        const msg = (g.errors as Record<string, string>)[body.code] ?? g.errors.failed;
        setError(name ? `${name}: ${msg}` : msg);
        return;
      }
      setOpen(false);
      setMentorId('');
      setPicked([]);
      onCreated();
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button
        variant="outline"
        data-testid="group-create-open"
        onClick={() => {
          setError('');
          setOpen(true);
        }}
      >
        {g.create}
      </Button>
      {open && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="group-create-title" className="bg-white dark:bg-gray-900 rounded-xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <h2 id="group-create-title" className="text-xl font-bold text-gray-900 mb-2">{g.create}</h2>
            <p className="text-sm text-gray-500 mb-4">{g.hint.replace('{max}', String(GROUP_MAX_MENTEES))}</p>
            {error && <div role="alert" data-testid="group-create-error" className="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}
            <Select
              label={t.mentorships.mentor}
              data-testid="group-mentor"
              value={mentorId}
              onChange={(e) => setMentorId(e.target.value)}
              placeholder={t.mentorships.selectMentor}
              options={mentors.map((m) => ({ value: m.id, label: m.fullName }))}
            />
            <fieldset className="mt-4">
              <legend className="text-sm font-medium text-gray-700 mb-2">
                {g.mentees} ({picked.length}/{GROUP_MAX_MENTEES})
              </legend>
              <input
                type="search"
                data-testid="group-mentee-filter"
                aria-label={g.filter}
                placeholder={g.filter}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="w-full mb-2 rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
              <div className="max-h-56 overflow-y-auto space-y-1 border border-gray-200 rounded-lg p-2">
                {rows.map((m) => (
                  <label key={m.id} className="flex items-center gap-2 text-sm text-gray-800">
                    <input type="checkbox" data-testid={`group-mentee-${m.id}`} checked={isPicked(m.id)} onChange={() => toggle(m)} disabled={!isPicked(m.id) && picked.length >= GROUP_MAX_MENTEES} />
                    {m.fullName}
                  </label>
                ))}
              </div>
              {found.total > found.people.length && (
                <p className="mt-1 text-xs text-gray-500" data-testid="group-mentee-more">
                  {fillTemplate(t.personPicker.more, { shown: String(found.people.length), total: String(found.total) })}
                </p>
              )}
            </fieldset>
            <div className="flex justify-end gap-3 mt-6">
              <Button variant="outline" onClick={() => setOpen(false)}>{t.common.cancel}</Button>
              <Button onClick={submit} loading={saving} data-testid="group-create-submit">{g.createSubmit}</Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
