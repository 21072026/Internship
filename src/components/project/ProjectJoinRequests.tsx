'use client';

import { useCallback, useEffect, useState } from 'react';
import { UserCheck, UserX, Inbox } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { useT } from '@/i18n/client';
import { PersonHoverCard } from '@/components/PersonHoverCard';

// Join requests, from the owner's side (#51). Approving is the whole point of
// the screen: it adds the ProjectMember row (with the role the applicant asked
// for) and pulls them into the group chat, so there is nothing left to do by hand.

interface JoinRequest {
  id: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  message: string | null;
  functionalRole: 'DEVELOPER' | 'TESTER' | 'MARKETING' | null;
  createdAt: string;
  user: { id: string; fullName: string; role: string; university: string | null; department: string | null };
}

export function ProjectJoinRequests({ projectId }: { projectId: string }) {
  const t = useT();
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}/join-requests`);
    if (!res.ok) { setLoading(false); return; }
    const d = await res.json();
    setRequests(d.requests ?? []);
    setLoading(false);
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const decide = async (request: JoinRequest, decision: 'APPROVED' | 'REJECTED') => {
    setBusy(request.id);
    setError('');
    try {
      const res = await fetch(`/api/projects/${projectId}/join-requests`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: request.id, decision, functionalRole: request.functionalRole }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || t.common.error);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t.common.error);
    } finally {
      setBusy('');
    }
  };

  if (loading || requests.length === 0) return null;
  const pending = requests.filter((r) => r.status === 'PENDING');

  return (
    <div data-testid="join-requests">
      <h2 className="mb-1.5 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
        <Inbox className="h-4 w-4 text-gray-400" /> {t.projects.joinRequests}
        {pending.length > 0 && <Badge variant="warning">{pending.length}</Badge>}
      </h2>
      <ul className="space-y-2">
        {requests.map((r) => (
          <li key={r.id} className="rounded-xl border border-gray-200 p-3 text-sm dark:border-gray-800" data-testid={`join-request-${r.id}`}>
            <div className="flex flex-wrap items-center gap-2">
              {/* The applicant is a stranger until you decide on them, so their
                  name is the one place on this screen that has to answer "who is
                  this?" — the card does it without leaving the queue (#1166). */}
              <PersonHoverCard
                personId={r.user.id}
                name={r.user.fullName}
                role={r.user.role}
                className="font-medium text-gray-800 dark:text-gray-200"
              />
              {r.functionalRole && (
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-800">
                  {(t.projects.functionalRoles as Record<string, string>)[r.functionalRole]}
                </span>
              )}
              {r.status !== 'PENDING' && (
                <Badge variant={r.status === 'APPROVED' ? 'success' : 'default'}>
                  {r.status === 'APPROVED' ? t.projects.approved : t.projects.declined}
                </Badge>
              )}
            </div>
            {(r.user.university || r.user.department) && (
              <p className="mt-0.5 text-xs text-gray-400">{[r.user.university, r.user.department].filter(Boolean).join(' · ')}</p>
            )}
            {r.message && <p className="mt-1 whitespace-pre-wrap text-gray-600 dark:text-gray-300">{r.message}</p>}
            {r.status === 'PENDING' && (
              <div className="mt-2 flex gap-2">
                <Button type="button" size="sm" loading={busy === r.id} onClick={() => decide(r, 'APPROVED')} data-testid={`approve-${r.id}`}>
                  <UserCheck className="mr-1 h-3.5 w-3.5" /> {t.projects.approve}
                </Button>
                <Button type="button" size="sm" variant="outline" loading={busy === r.id} onClick={() => decide(r, 'REJECTED')} data-testid={`reject-${r.id}`}>
                  <UserX className="mr-1 h-3.5 w-3.5" /> {t.projects.decline}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
