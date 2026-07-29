'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { UserPlus, Search } from 'lucide-react';
import { useT } from '@/i18n/client';

export interface MessageableUser {
  id: string;
  fullName: string;
  /** Which shared project makes this person messageable (shown as context). */
  projectName: string;
}

// "New chat" picker (#770): the project co-members the viewer may DM but has no
// conversation with yet. The candidate list is computed on the server (project
// membership + canMessage) — this component only picks from it, and the
// create-or-get endpoint re-checks permission anyway.
export function StartConversationPicker({ candidates }: { candidates: MessageableUser[] }) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((c) => c.fullName.toLowerCase().includes(q) || c.projectName.toLowerCase().includes(q));
  }, [candidates, filter]);

  const start = async (userId: string) => {
    setBusyId(userId);
    setError('');
    try {
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.conversation?.id) {
        router.push(`/messages/c/${data.conversation.id}`);
        return;
      }
      setError(data.error === 'Forbidden' ? t.messages.startNotAllowed : t.messages.startFailed);
    } catch {
      setError(t.messages.startFailed);
    } finally {
      setBusyId(null);
    }
  };

  if (candidates.length === 0) return null;

  return (
    <div className="border-t border-gray-100 dark:border-gray-800 pt-3 mt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="new-chat-toggle"
        aria-expanded={open}
        className="flex items-center gap-2 text-sm font-medium text-blue-600 hover:text-blue-700 px-2 py-1.5"
      >
        <UserPlus className="h-4 w-4" />
        {t.messages.newChat}
      </button>

      {open && (
        <div className="mt-2 px-2">
          <p className="text-xs text-gray-400 mb-2">{t.messages.newChatHint}</p>
          {candidates.length > 6 && (
            <div className="relative mb-2">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
              <input
                type="search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={t.messages.newChatSearch}
                data-testid="new-chat-search"
                className="w-full rounded-lg border border-gray-300 pl-7 pr-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 dark:bg-gray-900 dark:border-gray-700"
              />
            </div>
          )}
          {error && <p className="text-xs text-red-600 mb-2">{error}</p>}
          <div className="divide-y divide-gray-50 dark:divide-gray-800 max-h-64 overflow-y-auto">
            {shown.length === 0 ? (
              <p className="text-xs text-gray-400 py-3">{t.messages.newChatNoMatch}</p>
            ) : (
              shown.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => start(c.id)}
                  disabled={busyId !== null}
                  data-testid="new-chat-candidate"
                  className="w-full flex items-center gap-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-800 rounded-lg px-1 disabled:opacity-50"
                >
                  <div className="w-8 h-8 shrink-0 rounded-full bg-emerald-100 flex items-center justify-center text-xs font-semibold text-emerald-700">
                    {c.fullName.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{c.fullName}</span>
                    <span className="block text-xs text-gray-400 truncate">{c.projectName}</span>
                  </div>
                  {busyId === c.id && <span className="text-xs text-gray-400">{t.common.loading}</span>}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
