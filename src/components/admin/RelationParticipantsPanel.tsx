'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT, useLocale } from '@/i18n/client';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { formatDate } from '@/lib/relativeTime';

interface Participant {
  id: string | null;
  userId: string;
  fullName: string | null;
  role: string;
  primary: boolean;
  joinedAt: string | null;
  leftAt: string | null;
}

/**
 * The members of one GROUP (#1804): the pair first, then every seat, left
 * ones kept as history. An admin seats another mentee or a co-mentor, or lets
 * a seat go (`leftAt`); the pair itself changes only through the transfer.
 */
export function RelationParticipantsPanel({ relationId, active, candidates }: { relationId: string; active: boolean; candidates: { id: string; fullName: string }[] }) {
  const t = useT();
  const locale = useLocale();
  const g = t.relationGroups;
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Participant[]>([]);
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState('MENTEE');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/relations/${relationId}/participants`);
    if (res.ok) setRows((await res.json()).participants);
  }, [relationId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function answer(res: Response) {
    if (res.ok) {
      setRows((await res.json()).participants);
      setUserId('');
      return;
    }
    const body = await res.json().catch(() => ({}));
    setError((g.errors as Record<string, string>)[body.code] ?? g.errors.failed);
  }

  async function add() {
    if (!userId) return;
    setError('');
    setBusy(true);
    try {
      await answer(await fetch(`/api/admin/relations/${relationId}/participants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, role }),
      }));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setError('');
    setBusy(true);
    try {
      await answer(await fetch(`/api/admin/relations/${relationId}/participants?userId=${encodeURIComponent(id)}`, { method: 'DELETE' }));
    } finally {
      setBusy(false);
    }
  }

  const current = new Set(rows.filter((r) => !r.leftAt).map((r) => r.userId));

  return (
    <div className="mt-3">
      <button type="button" className="text-sm font-medium text-blue-700 hover:underline" aria-expanded={open} data-testid={`group-members-toggle-${relationId}`} onClick={() => setOpen((o) => !o)}>
        {open ? g.hideMembers : g.showMembers}
      </button>
      {open && (
        <div className="mt-2 space-y-2" data-testid={`group-members-${relationId}`}>
          <ul className="divide-y divide-gray-100 text-sm">
            {rows.map((r) => (
              <li key={`${r.userId}-${r.id ?? 'pair'}`} className="flex items-center justify-between gap-2 py-1.5">
                <span className={r.leftAt ? 'text-gray-400 line-through' : 'text-gray-800'}>
                  {r.fullName} <Badge variant="default">{g.roles[r.role as keyof typeof g.roles] ?? r.role}</Badge>
                  {r.primary && <span className="ml-1 text-xs text-gray-500">{g.primary}</span>}
                  {r.leftAt && <span className="ml-1 text-xs">{g.leftOn.replace('{date}', formatDate(r.leftAt, locale))}</span>}
                </span>
                {active && !r.primary && !r.leftAt && (
                  <Button size="sm" variant="outline" disabled={busy} data-testid={`group-remove-${r.userId}`} onClick={() => remove(r.userId)}>
                    {g.remove}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {error && <p role="alert" className="text-sm text-red-700" data-testid="group-member-error">{error}</p>}
          {active && (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <Select
                aria-label={g.addPerson}
                data-testid={`group-add-person-${relationId}`}
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                placeholder={g.addPerson}
                options={candidates.filter((c) => !current.has(c.id)).map((c) => ({ value: c.id, label: c.fullName }))}
                className="sm:w-56"
              />
              <Select
                aria-label={g.role}
                value={role}
                onChange={(e) => setRole(e.target.value)}
                options={(['MENTEE', 'MENTOR', 'FACILITATOR'] as const).map((r) => ({ value: r, label: g.roles[r] }))}
                className="sm:w-40"
              />
              <Button size="sm" onClick={add} loading={busy} disabled={!userId} data-testid={`group-add-${relationId}`}>
                {g.add}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
