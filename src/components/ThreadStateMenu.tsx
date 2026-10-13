'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MoreVertical } from 'lucide-react';
import { useT } from '@/i18n/client';
import type { MuteChoice } from '@/lib/conversationState';

type Change = { archived?: boolean; pinned?: boolean; mute?: MuteChoice | null };

// Per-thread inbox actions (#1609): pin, mute, archive — the viewer's own
// state, written through PATCH /api/conversations/[id]/state. The inbox is a
// server component, so a change re-renders it rather than patching rows here.
export function ThreadStateMenu({
  conversationId,
  pinned,
  muted,
  archived,
}: {
  conversationId: string;
  pinned: boolean;
  muted: boolean;
  archived: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const change = async (body: Change) => {
    setBusy(true);
    setError(false);
    try {
      const res = await fetch(`/api/conversations/${conversationId}/state`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) { setError(true); return; }
      setOpen(false);
      router.refresh();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  const S = t.messages.threadState;
  const item = (label: string, testId: string, body: Change) => (
    <button
      type="button"
      role="menuitem"
      disabled={busy}
      onClick={() => void change(body)}
      data-testid={testId}
      className="block w-full px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:text-gray-200 dark:hover:bg-gray-800"
    >
      {label}
    </button>
  );

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={S.menu}
        data-testid={`thread-state-menu-${conversationId}`}
        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-100"
      >
        <MoreVertical className="h-4 w-4" aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-56 overflow-hidden rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-900"
          data-testid="thread-state-options"
        >
          {pinned ? item(S.unpin, 'thread-state-unpin', { pinned: false }) : item(S.pin, 'thread-state-pin', { pinned: true })}
          {muted ? (
            item(S.unmute, 'thread-state-unmute', { mute: null })
          ) : (
            <>
              {item(S.mute8h, 'thread-state-mute-8h', { mute: '8h' })}
              {item(S.mute1w, 'thread-state-mute-1w', { mute: '1w' })}
              {item(S.muteForever, 'thread-state-mute-forever', { mute: 'forever' })}
            </>
          )}
          {archived
            ? item(S.unarchive, 'thread-state-unarchive', { archived: false })
            : item(S.archive, 'thread-state-archive', { archived: true })}
          {error && <p className="px-3 py-2 text-xs text-red-600" role="alert">{S.failed}</p>}
        </div>
      )}
    </div>
  );
}
