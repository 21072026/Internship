'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { MessageSquare, Users, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { useT } from '@/i18n/client';

// Shortcuts on a project (#51). A member is in a group chat with these people
// and is expected to talk to the person who owns the project, but there was no
// way to get to either from the project itself — you had to go find the thread.
// Non-members looking at a public project get the "ask to join" action instead.

type JoinStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | null;

export function ProjectQuickActions({
  projectId,
  ownerUserId,
  isMember,
  canRequestToJoin,
  joinStatus,
}: {
  projectId: string;
  ownerUserId: string | null;
  isMember: boolean;
  canRequestToJoin: boolean;
  joinStatus: JoinStatus;
}) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState<JoinStatus>(joinStatus);
  const [showForm, setShowForm] = useState(false);
  const [message, setMessage] = useState('');
  const [functionalRole, setFunctionalRole] = useState<'DEVELOPER' | 'TESTER' | 'MARKETING'>('DEVELOPER');

  // Both shortcuts go through the same create-or-get endpoint, which is where
  // the "may these two talk / is this person a member" rules live (#769).
  const openConversation = async (payload: Record<string, string>, key: string) => {
    setBusy(key);
    setError('');
    try {
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.conversation?.id) throw new Error(data.error || t.common.error);
      router.push(`/messages/c/${data.conversation.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : t.common.error);
    } finally {
      setBusy('');
    }
  };

  const requestToJoin = async () => {
    setBusy('join');
    setError('');
    try {
      const res = await fetch(`/api/projects/${projectId}/join-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, functionalRole }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t.common.error);
      setStatus('PENDING');
      setShowForm(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : t.common.error);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="mt-6 space-y-2" data-testid="project-quick-actions">
      <div className="flex flex-wrap gap-2">
        {isMember && (
          <Button type="button" size="sm" variant="outline" loading={busy === 'group'} onClick={() => openConversation({ projectId }, 'group')} data-testid="open-group-chat">
            <Users className="mr-1 h-4 w-4" /> {t.projects.groupChat}
          </Button>
        )}
        {ownerUserId && (
          <Button type="button" size="sm" variant="outline" loading={busy === 'owner'} onClick={() => openConversation({ userId: ownerUserId }, 'owner')} data-testid="message-owner">
            <MessageSquare className="mr-1 h-4 w-4" /> {t.projects.messageOwner}
          </Button>
        )}
        {canRequestToJoin && !status && !showForm && (
          <Button type="button" size="sm" onClick={() => setShowForm(true)} data-testid="request-to-join">
            <UserPlus className="mr-1 h-4 w-4" /> {t.projects.requestToJoin}
          </Button>
        )}
      </div>

      {status === 'PENDING' && <p className="text-xs text-amber-600" data-testid="join-pending">{t.projects.joinPending}</p>}
      {status === 'REJECTED' && (
        <div className="space-y-1">
          <p className="text-xs text-gray-500">{t.projects.joinRejected}</p>
          {canRequestToJoin && !showForm && (
            <Button type="button" size="sm" variant="outline" onClick={() => setShowForm(true)}>
              {t.projects.requestAgain}
            </Button>
          )}
        </div>
      )}

      {showForm && (
        <div className="max-w-md space-y-2 rounded-xl border border-gray-200 p-3 dark:border-gray-800">
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-300">{t.projects.joinRole}</label>
          <select
            value={functionalRole}
            onChange={(e) => setFunctionalRole(e.target.value as 'DEVELOPER' | 'TESTER' | 'MARKETING')}
            data-testid="join-role"
            className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
          >
            {(['DEVELOPER', 'TESTER', 'MARKETING'] as const).map((fr) => (
              <option key={fr} value={fr}>{(t.projects.functionalRoles as Record<string, string>)[fr]}</option>
            ))}
          </select>
          <Textarea rows={3} maxLength={2000} value={message} placeholder={t.projects.joinMessage} onChange={(e) => setMessage(e.target.value)} />
          <div className="flex gap-2">
            <Button type="button" size="sm" loading={busy === 'join'} onClick={requestToJoin} data-testid="submit-join-request">
              {t.projects.sendRequest}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setShowForm(false)}>{t.common.cancel}</Button>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
