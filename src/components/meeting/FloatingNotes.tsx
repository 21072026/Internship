'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '@/i18n/client';
import { openFloatingWindow, type FloatingWindow } from '@/lib/floatingWindow';

// Notes taken during a meeting, in a window that stays on top of everything
// (#1057). The window is a real DOM rendered through a React portal, so this is
// ordinary UI code — only its host document differs.

const AUTOSAVE_MS = 2000;
const MAX_LENGTH = 5000;
// Belt and braces: whatever is typed also lands in localStorage on every
// keystroke, so a failed request, a closed tab or a crashed window can't take
// the notes with it.
const DRAFT_KEY = 'floating-note-draft';

interface OpenOptions {
  meetingId?: string;
  title?: string;
}

const NotesContext = createContext<((opts: OpenOptions) => Promise<void>) | null>(null);

export function useFloatingNotes() {
  const open = useContext(NotesContext);
  if (!open) throw new Error('useFloatingNotes must be used inside FloatingNotesProvider');
  return open;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export function FloatingNotesProvider({ children }: { children: React.ReactNode }) {
  const [floating, setFloating] = useState<FloatingWindow | null>(null);
  const [context, setContext] = useState<OpenOptions>({});
  const [blocked, setBlocked] = useState(false);

  const close = useCallback(() => {
    setFloating((current) => {
      try {
        current?.win.close();
      } catch {
        /* already closed */
      }
      return null;
    });
  }, []);

  const open = useCallback(async (opts: OpenOptions) => {
    setBlocked(false);
    // No await before this call — see openFloatingWindow's contract: the user
    // gesture must still be live.
    const win = await openFloatingWindow({ title: opts.title });
    if (!win) {
      setBlocked(true);
      return;
    }
    setContext(opts);
    setFloating(win);
    // The opener owns this window; if it goes away on its own (the user closed
    // it, or the opener tab navigated), drop our reference.
    win.win.addEventListener('pagehide', () => setFloating(null), { once: true });
  }, []);

  // Closing the opener must not leave an orphan window floating over the desktop.
  useEffect(() => {
    if (!floating) return;
    const onUnload = () => {
      try {
        floating.win.close();
      } catch {
        /* nothing to do */
      }
    };
    window.addEventListener('pagehide', onUnload);
    return () => window.removeEventListener('pagehide', onUnload);
  }, [floating]);

  return (
    <NotesContext.Provider value={open}>
      {children}
      {blocked && <PopupBlockedNotice onDismiss={() => setBlocked(false)} />}
      {floating &&
        createPortal(
          <NotesWindowBody
            kind={floating.kind}
            win={floating.win}
            meetingId={context.meetingId}
            title={context.title}
            onClose={close}
          />,
          floating.mount
        )}
    </NotesContext.Provider>
  );
}

function PopupBlockedNotice({ onDismiss }: { onDismiss: () => void }) {
  const t = useT();
  return (
    <div
      role="alert"
      data-testid="floating-notes-blocked"
      className="fixed bottom-4 left-4 z-[200] max-w-sm rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 shadow-lg dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100"
    >
      <p>{t.meetings.notesWindow.blocked}</p>
      <button type="button" onClick={onDismiss} className="mt-1 font-medium underline">
        {t.meetings.notesWindow.close}
      </button>
    </div>
  );
}

function NotesWindowBody({
  kind,
  win,
  meetingId,
  title,
  onClose,
}: {
  kind: 'pip' | 'popup';
  // The floating window itself. This component's code runs in the *opener's* JS
  // context — a portal moves DOM, not execution — so a bare `window` here is the
  // opener, and unload listeners have to be attached to this one explicitly.
  win: Window;
  meetingId?: string;
  title?: string;
  onClose: () => void;
}) {
  const t = useT();
  const [text, setText] = useState('');
  const [state, setState] = useState<SaveState>('idle');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  // The note row is created on first save and updated after that, so a session
  // of typing is one note rather than a dozen fragments.
  const noteIdRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef('');

  // Recover anything a previous window left behind before it could save.
  useEffect(() => {
    try {
      const draft = localStorage.getItem(DRAFT_KEY);
      if (draft) {
        setText(draft);
        latest.current = draft;
      }
    } catch {
      /* storage disabled */
    }
  }, []);

  const save = useCallback(async () => {
    const body = latest.current.trim();
    if (!body) return;
    setState('saving');
    try {
      const res = noteIdRef.current
        ? await fetch(`/api/notes/${noteIdRef.current}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body, category: 'MEETING', ...(meetingId ? { meetingId } : {}) }),
          })
        : await fetch('/api/notes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body, category: 'MEETING', ...(meetingId ? { meetingId } : {}) }),
          });
      if (!res.ok) {
        setState('error');
        return;
      }
      const data = await res.json();
      if (data?.note?.id) noteIdRef.current = data.note.id;
      setState('saved');
      setSavedAt(new Date().toLocaleTimeString());
      // Only now is it safe to drop the local copy.
      try {
        localStorage.removeItem(DRAFT_KEY);
      } catch {
        /* storage disabled */
      }
    } catch {
      setState('error');
    }
  }, [meetingId]);

  const onChange = (value: string) => {
    setText(value);
    latest.current = value;
    try {
      localStorage.setItem(DRAFT_KEY, value);
    } catch {
      /* storage disabled */
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void save(), AUTOSAVE_MS);
  };

  // Last write wins on the way out: a debounce timer that never fired would
  // otherwise lose the final sentence — the one people actually care about.
  useEffect(() => {
    const flush = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      void save();
    };
    // Both windows: the floating one closing, and the opener going away (which
    // takes the floating one with it).
    win.addEventListener('pagehide', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      win.removeEventListener('pagehide', flush);
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [save, win]);

  const remaining = MAX_LENGTH - text.length;

  return (
    <div className="flex h-screen flex-col bg-white p-3 text-gray-900 dark:bg-gray-900 dark:text-gray-100">
      <div className="mb-2 flex items-start gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold" title={title}>
            {title || t.meetings.notesWindow.title}
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {state === 'saving' && t.meetings.notesWindow.saving}
            {state === 'saved' && `${t.meetings.notesWindow.saved} · ${savedAt}`}
            {state === 'error' && (
              <span className="text-red-600 dark:text-red-400">{t.meetings.notesWindow.saveFailed}</span>
            )}
            {state === 'idle' && t.meetings.notesWindow.hint}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          {t.meetings.notesWindow.close}
        </button>
      </div>

      {kind === 'popup' && (
        <p
          data-testid="floating-notes-popup-warning"
          className="mb-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100"
        >
          {t.meetings.notesWindow.notOnTop}
        </p>
      )}

      <textarea
        data-testid="floating-notes-textarea"
        autoFocus
        value={text}
        maxLength={MAX_LENGTH}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t.meetings.notesWindow.placeholder}
        className="min-h-0 flex-1 resize-none rounded-lg border border-gray-300 bg-white p-2 text-sm text-gray-900 outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
      />

      <div className="mt-1.5 flex items-center gap-2 text-xs text-gray-400">
        {/* Silently refusing further keystrokes at the cap would read as a
            broken keyboard, so warn while there is still room to react. */}
        {remaining < 500 && <span className={remaining < 100 ? 'text-amber-600' : ''}>{remaining}</span>}
        <button
          type="button"
          onClick={() => void save()}
          className="ml-auto rounded px-2 py-1 font-medium text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950"
        >
          {t.meetings.notesWindow.saveNow}
        </button>
      </div>
    </div>
  );
}
