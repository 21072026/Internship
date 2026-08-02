'use client';

import { useCallback, useEffect, useState } from 'react';
import { Trash2, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { useT } from '@/i18n/client';
import { durationSince } from '@/lib/relativeTime';

// Managing who is on the project (#617/#618/#51).
//
// This used to live in a panel that expanded inside the project *card* on the
// list screen, which meant a project had two half-views: the card (roster,
// members, a flat task checklist) and the detail page (team, goals, meeting).
// The list is a list now; everything about one project happens here.

interface Member {
  role: 'OWNER' | 'MENTOR' | 'MENTEE';
  functionalRole: 'DEVELOPER' | 'TESTER' | 'MARKETING' | null;
  addedAt?: string;
  user: { id: string; fullName: string; role: string };
}

export function ProjectMembersPanel({ projectId, myId }: { projectId: string; myId: string }) {
  const t = useT();
  const [members, setMembers] = useState<Member[]>([]);
  const [mentors, setMentors] = useState<{ id: string; fullName: string }[]>([]);
  const [mentees, setMentees] = useState<{ id: string; fullName: string }[]>([]);
  const [addUserId, setAddUserId] = useState('');
  const [addRole, setAddRole] = useState<'OWNER' | 'MENTOR'>('MENTOR');
  const [addMenteeId, setAddMenteeId] = useState('');
  const [addFunc, setAddFunc] = useState<'DEVELOPER' | 'TESTER' | 'MARKETING'>('DEVELOPER');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}/members`);
    if (res.ok) setMembers((await res.json()).members ?? []);
    setLoading(false);
  }, [projectId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    fetch('/api/users?view=picker')
      .then((r) => (r.ok ? r.json() : { users: [] }))
      .then((d) => {
        const users = (d.users ?? []) as { id: string; fullName: string; role: string }[];
        setMentors(users.filter((u) => u.role === 'MENTOR' || u.role === 'ADMIN'));
        setMentees(users.filter((u) => u.role === 'MENTEE'));
      })
      .catch(() => {});
  }, []);

  const call = async (method: 'POST' | 'DELETE', body: Record<string, unknown>) => {
    setError('');
    const res = await fetch(`/api/projects/${projectId}/members`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.code === 'last_owner' ? t.projects.lastOwnerError : d.error || t.common.error);
      return false;
    }
    await load();
    return true;
  };

  // Transfer = make the target an OWNER, then step down yourself.
  const transferTo = async () => {
    if (!addUserId) return;
    if (await call('POST', { userId: addUserId, role: 'OWNER' })) {
      await call('DELETE', { userId: myId });
    }
  };

  if (loading) return null;
  const iAmOwner = members.some((m) => m.user.id === myId && m.role === 'OWNER');

  return (
    <div data-testid="members-panel">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
        <UserPlus className="h-4 w-4 text-gray-400" /> {t.projects.manageOwners}
      </h2>
      {error && <p className="mb-2 text-xs text-red-600">{error}</p>}

      <div className="mb-3 space-y-1" data-testid="owners-members">
        {members.map((m) => (
          <div key={m.user.id} className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant={m.role === 'OWNER' ? 'info' : m.role === 'MENTEE' ? 'purple' : 'default'} className="text-xs">
              {m.role === 'OWNER' ? t.projects.roleOwner : m.role === 'MENTEE' ? t.projects.roleMentee : t.projects.roleMentorMember}
            </Badge>
            {m.role === 'MENTEE' && m.functionalRole && (
              <Badge variant="default" className="text-xs">
                {(t.projects.functionalRoles as Record<string, string>)[m.functionalRole]}
              </Badge>
            )}
            <span className="min-w-0 flex-1 text-gray-800 dark:text-gray-200">
              {m.user.fullName}
              {m.addedAt && (() => {
                const { count, unit } = durationSince(m.addedAt);
                const noun = count === 1 ? t.membership[unit] : t.membership[`${unit}s` as 'days' | 'months' | 'years'];
                return <span className="ml-1.5 text-xs text-gray-400">· {t.membership.inProjectFor.replace('{d}', `${count} ${noun}`)}</span>;
              })()}
            </span>
            <button
              type="button"
              onClick={() => call('DELETE', { userId: m.user.id })}
              aria-label={t.common.delete}
              data-testid={`member-remove-${m.user.id}`}
              className="text-gray-300 hover:text-red-600"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>

      {/* Owners & mentors. Stacked on a phone: three controls side by side leave
          the select ~60px wide and unreadable. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <select
          value={addUserId}
          onChange={(e) => setAddUserId(e.target.value)}
          data-testid="member-picker"
          className="w-full min-w-0 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 sm:w-auto"
        >
          <option value="">—</option>
          {mentors.filter((m) => !members.some((x) => x.user.id === m.id)).map((m) => (
            <option key={m.id} value={m.id}>{m.fullName}</option>
          ))}
        </select>
        <select
          value={addRole}
          onChange={(e) => setAddRole(e.target.value as 'OWNER' | 'MENTOR')}
          className="w-full min-w-0 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 sm:w-auto"
        >
          <option value="MENTOR">{t.projects.roleMentorMember}</option>
          <option value="OWNER">{t.projects.roleOwner}</option>
        </select>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="outline" disabled={!addUserId} onClick={() => call('POST', { userId: addUserId, role: addRole }).then((ok) => { if (ok) setAddUserId(''); })} data-testid="member-add">
            {t.projects.add}
          </Button>
          {iAmOwner && (
            <Button type="button" size="sm" variant="secondary" disabled={!addUserId} onClick={transferTo} data-testid="member-transfer">
              {t.projects.transfer}
            </Button>
          )}
        </div>
      </div>

      {/* Mentee members with a functional (job) role (#51). */}
      <div className="mt-3 border-t border-gray-100 pt-3 dark:border-gray-800">
        <p className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">{t.projects.addMenteeMember}</p>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <select
            value={addMenteeId}
            onChange={(e) => setAddMenteeId(e.target.value)}
            data-testid="mentee-picker"
            className="w-full min-w-0 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 sm:w-auto"
          >
            <option value="">—</option>
            {mentees.filter((m) => !members.some((x) => x.user.id === m.id)).map((m) => (
              <option key={m.id} value={m.id}>{m.fullName}</option>
            ))}
          </select>
          <select
            value={addFunc}
            onChange={(e) => setAddFunc(e.target.value as 'DEVELOPER' | 'TESTER' | 'MARKETING')}
            data-testid="functional-role-picker"
            className="w-full min-w-0 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 sm:w-auto"
          >
            {(['DEVELOPER', 'TESTER', 'MARKETING'] as const).map((fr) => (
              <option key={fr} value={fr}>{(t.projects.functionalRoles as Record<string, string>)[fr]}</option>
            ))}
          </select>
          <Button type="button" size="sm" variant="outline" disabled={!addMenteeId} onClick={() => call('POST', { userId: addMenteeId, role: 'MENTEE', functionalRole: addFunc }).then((ok) => { if (ok) setAddMenteeId(''); })} data-testid="mentee-add">
            {t.projects.add}
          </Button>
        </div>
        {mentees.length === 0 && <p className="mt-1.5 text-xs text-gray-400">{t.projects.noMenteesToAdd}</p>}
      </div>
    </div>
  );
}
