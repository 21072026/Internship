'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, Video, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { useT } from '@/i18n/client';
import { isEmbeddableMeetingLink } from '@/lib/meetingLink';
import { meetingNotesAutoOpen, useFloatingNotes } from '@/components/meeting/FloatingNotes';

// "Start a meeting now" (#1053, #1054).
//
// Mounted once in Providers, above every page shell — deliberately: a call must
// survive navigating around the app. If the panel lived inside a page, walking
// from the mentee list to their profile would drop the meeting.

export interface MeetingTarget {
  relationIds?: string[];
  projectId?: string;
  conversationId?: string;
}

interface StartOptions {
  target: MeetingTarget;
  // Pre-fills the topic box; the user only has to confirm.
  defaultTitle?: string;
}

interface ActiveMeeting {
  meetingId: string;
  meetLink: string;
  title: string;
}

const LauncherContext = createContext<((opts: StartOptions) => void) | null>(null);

// Mounting above the page shells keeps the panel alive across client-side
// navigation, but a full page load (an external link back into the app, a
// refresh, a hard nav) still rebuilds the tree — and dropping a call in progress
// because someone reloaded is not acceptable. sessionStorage, not localStorage:
// the room belongs to this tab and should not haunt a new one tomorrow.
const ACTIVE_KEY = 'active-meeting';

function readActive(): ActiveMeeting | null {
  try {
    const raw = sessionStorage.getItem(ACTIVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ActiveMeeting>;
    if (!parsed?.meetingId || !parsed?.meetLink) return null;
    return { meetingId: parsed.meetingId, meetLink: parsed.meetLink, title: parsed.title ?? '' };
  } catch {
    return null;
  }
}

function writeActive(meeting: ActiveMeeting | null) {
  try {
    if (meeting) sessionStorage.setItem(ACTIVE_KEY, JSON.stringify(meeting));
    else sessionStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* private mode / storage disabled — the panel just won't survive a reload */
  }
}

export function useMeetingLauncher() {
  const start = useContext(LauncherContext);
  if (!start) throw new Error('useMeetingLauncher must be used inside MeetingLauncherProvider');
  return start;
}

export function MeetingLauncherProvider({ children }: { children: React.ReactNode }) {
  const t = useT();
  const toast = useToast();
  // FloatingNotesProvider wraps this one (see Providers), so the notes window is
  // available here and the two open on the same click.
  const notes = useFloatingNotes();
  const [pending, setPending] = useState<StartOptions | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [active, setActive] = useState<ActiveMeeting | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const start = useCallback((opts: StartOptions) => {
    setError('');
    setTitle(opts.defaultTitle ?? '');
    setPending(opts);
  }, []);

  useEffect(() => {
    if (pending) inputRef.current?.focus();
  }, [pending]);

  // After mount, never during render: reading storage while rendering would
  // make the server and client markup disagree.
  useEffect(() => {
    const restored = readActive();
    if (restored) setActive(restored);
  }, []);

  const openPanel = useCallback((meeting: ActiveMeeting | null) => {
    setActive(meeting);
    writeActive(meeting);
  }, []);

  const confirm = async () => {
    if (!pending || busy) return;
    const trimmed = title.trim();
    if (!trimmed) {
      setError(t.meetings.instant.topicRequired);
      return;
    }
    setBusy(true);
    setError('');

    // FIRST, before any await (#1058). Opening the floating window needs
    // transient user activation, and the fetch below would spend it — the
    // window would then silently never open. So the window is opened on the
    // click and the room is attached to it once the server answers.
    const wantsNotes = meetingNotesAutoOpen();
    const notesOpening = wantsNotes ? notes.open({ title: trimmed }) : Promise.resolve(false);

    try {
      const res = await fetch('/api/meetings/instant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmed, ...pending.target }),
      });
      if (!res.ok) {
        setError(res.status === 429 ? t.meetings.instant.tooMany : t.meetings.instant.failed);
        // Don't leave an empty notes window floating over a meeting that never
        // started — the user would have no idea what it belongs to.
        if (await notesOpening) notes.close();
        return;
      }
      const data: { meetingId: string; meetLink: string; invited: number } = await res.json();
      setPending(null);
      openPanel({ meetingId: data.meetingId, meetLink: data.meetLink, title: trimmed });
      // Now the window knows which room it is taking notes for.
      if (await notesOpening) notes.attach({ meetingId: data.meetingId, title: trimmed });
      // Copying is best-effort: the link is on screen either way, and a blocked
      // clipboard must not read as "the meeting failed".
      try {
        await navigator.clipboard.writeText(data.meetLink);
        toast(t.meetings.instant.startedAndCopied.replace('{n}', String(data.invited)));
      } catch {
        toast(t.meetings.instant.started.replace('{n}', String(data.invited)));
      }
    } catch {
      setError(t.meetings.instant.failed);
      if (await notesOpening) notes.close();
    } finally {
      setBusy(false);
    }
  };

  return (
    <LauncherContext.Provider value={start}>
      {children}

      {pending && (
        <div
          className="fixed inset-0 z-[150] flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={t.meetings.instant.start}
          onClick={() => !busy && setPending(null)}
        >
          <div
            className="w-full max-w-md rounded-xl bg-white dark:bg-gray-900 p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">
              {t.meetings.instant.start}
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">{t.meetings.instant.topicHint}</p>
            <Input
              ref={inputRef}
              data-testid="instant-meeting-topic"
              value={title}
              maxLength={200}
              placeholder={t.meetings.instant.topicPlaceholder}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirm();
                if (e.key === 'Escape' && !busy) setPending(null);
              }}
            />
            {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setPending(null)} disabled={busy}>
                {t.common.cancel}
              </Button>
              <Button
                size="sm"
                onClick={confirm}
                loading={busy}
                disabled={busy}
                data-testid="instant-meeting-confirm"
              >
                <Video className="h-4 w-4" />
                {t.meetings.instant.start}
              </Button>
            </div>
          </div>
        </div>
      )}

      {active && <MeetingSidePanel meeting={active} onClose={() => openPanel(null)} />}
    </LauncherContext.Provider>
  );
}

// The call itself. On a wide screen it's a resizable right-hand column with the
// room embedded, so the mentee's record stays readable next to it. On a phone
// there is no room for both, so it collapses to a bar with a Join button rather
// than a postage-stamp video.
function MeetingSidePanel({ meeting, onClose }: { meeting: ActiveMeeting; onClose: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const embeddable = isEmbeddableMeetingLink(meeting.meetLink);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(meeting.meetLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt(t.meetings.copyLink, meeting.meetLink);
    }
  };

  return (
    <aside
      data-testid="meeting-side-panel"
      aria-label={t.meetings.instant.panelTitle}
      className="fixed z-[140] bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-800 shadow-2xl
                 inset-x-0 bottom-0 border-t
                 lg:inset-y-0 lg:left-auto lg:right-0 lg:w-[420px] lg:border-l lg:border-t-0
                 flex flex-col"
    >
      <header className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 dark:border-gray-800">
        <Video className="h-4 w-4 text-blue-600 flex-shrink-0" />
        <span className="font-medium text-sm text-gray-900 dark:text-gray-100 truncate" title={meeting.title}>
          {meeting.title}
        </span>
        <div className="ml-auto flex items-center gap-1 flex-shrink-0">
          <button
            type="button"
            onClick={copy}
            aria-label={t.meetings.copyLink}
            className="p-1.5 rounded text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            {copied ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
          </button>
          <a
            href={meeting.meetLink}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t.meetings.instant.openInNewTab}
            className="p-1.5 rounded text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <ExternalLink className="h-4 w-4" />
          </a>
          <button
            type="button"
            onClick={onClose}
            aria-label={t.meetings.instant.close}
            data-testid="meeting-side-panel-close"
            className="p-1.5 rounded text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* Desktop: the room itself. */}
      {embeddable ? (
        <iframe
          src={meeting.meetLink}
          title={t.meetings.instant.panelTitle}
          allow="camera; microphone; display-capture; fullscreen; autoplay; clipboard-write"
          className="hidden lg:block flex-1 w-full border-0"
        />
      ) : (
        <div className="hidden lg:flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-sm text-gray-600 dark:text-gray-400">{t.meetings.instant.notEmbeddable}</p>
          <a href={meeting.meetLink} target="_blank" rel="noopener noreferrer">
            <Button size="sm">
              <ExternalLink className="h-4 w-4" />
              {t.meetings.instant.openInNewTab}
            </Button>
          </a>
        </div>
      )}

      {/* Phone: a strip with a Join button — a video this small helps nobody. */}
      <div className="lg:hidden p-3">
        <a href={meeting.meetLink} target="_blank" rel="noopener noreferrer" className="block">
          <Button className="w-full" size="sm">
            <Video className="h-4 w-4" />
            {t.meetings.instant.join}
          </Button>
        </a>
      </div>
    </aside>
  );
}
