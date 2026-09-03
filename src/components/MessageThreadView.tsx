'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import { FileText, Download, MoreVertical, Check, CheckCheck, SmilePlus, Users2, FolderOpen, MessageSquareQuote, X } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useT, useLocale } from '@/i18n/client';
import { formatDateTime } from '@/lib/relativeTime';
import { Textarea } from '@/components/ui/Textarea';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ImageLightbox, useImageLightbox } from '@/components/ui/ImageLightbox';
import { TEXT_LIMITS } from '@/lib/textLimits';
import {
  MessageComposer,
  PendingAttachmentList,
  type PendingMessageAttachment,
} from '@/components/MessageThread';
import { useMessagesHeaderTitle } from '@/components/MessagesShell';
import { useIsNarrow } from '@/hooks/useIsNarrow';
import { useRealtime } from '@/hooks/useRealtime';
import { StartMeetingButton } from '@/components/meeting/StartMeetingButton';
import { LanguageBadge } from '@/components/LanguageBadge';
import { PersonHoverCard } from '@/components/PersonHoverCard';
import type { MeetingTarget } from '@/components/meeting/MeetingLauncher';
import { scrollBehavior } from '@/lib/motion';
import {
  resolveMessageTemplateText,
  templatePreview,
  type MessageTemplateDto,
} from '@/lib/messageTemplates';

interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}
interface Msg {
  id: string;
  senderId: string;
  body: string;
  channel: 'IN_APP' | 'EMAIL';
  readAt: string | null;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  attachments: Attachment[];
  reactions: { emoji: string; count: number; mine: boolean }[];
}

// Fixed reaction set (mirrors the server's REACTION_EMOJIS).
const REACTIONS = ['👍', '❤️', '😂', '😮', '🎉'] as const;
// Typing indicator (#1871). One publish per thread per throttle window — the
// point is "someone is writing", not a keystroke feed — and the receiving side
// forgets it EXPIRY after the last event it heard, because there is no
// "stopped typing" event to wait for and a stuck indicator is worse than none.
const TYPING_THROTTLE_MS = 3_000;
const TYPING_EXPIRY_MS = 5_000;
interface Party {
  id: string;
  fullName: string;
  // Which language they read, so the header can say so before you type (#1164).
  preferredLanguage?: string | null;
  // Group (project) chats also carry who each person is on the project (#51).
  role?: 'OWNER' | 'MENTOR' | 'MENTEE' | null;
  functionalRole?: 'DEVELOPER' | 'TESTER' | 'MARKETING' | null;
}

// Which thread this view is showing. A mentorship thread is addressed by its
// relation id (the original path); a conversation by its own id (#769/#770).
// Everything below is identical for both — only the query/POST field and the
// participant list differ, so the two routes share this one implementation
// instead of duplicating ~400 lines of message UI.
export type ThreadTarget =
  | { kind: 'relation'; id: string }
  | { kind: 'conversation'; id: string };

export function MessageThreadView({ target }: { target: ThreadTarget }) {

  const t = useT();
  const locale = useLocale();
  const narrow = useIsNarrow();
  const { data: session } = useSession();
  const myId = session?.user?.id;
  const [messages, setMessages] = useState<Msg[]>([]);
  // Everyone in this thread, used to label incoming bubbles and the header.
  const [parties, setParties] = useState<Party[]>([]);
  // Set for a project group chat: which project it belongs to, so the header can
  // name the room, list who is in it and link back to the project (#51).
  const [group, setGroup] = useState<{ projectId: string | null; projectName: string | null } | null>(null);
  // Who the mentor is, when a mentorship stands behind this 1:1 thread, so an
  // empty thread can suggest a *welcome* to the mentor and a neutral opener to
  // the mentee (#1130). Answered for conversations too since the mentorship
  // thread hands over to one (#1156).
  const [mentorId, setMentorId] = useState<string | null>(null);
  const [showParties, setShowParties] = useState(false);
  const [body, setBody] = useState('');
  // Pending attachments (picked files + pasted images), each with an object URL
  // for an instant thumbnail/preview. Uploaded with the message on send.
  const [attachments, setAttachments] = useState<PendingMessageAttachment[]>([]);
  const [attachError, setAttachError] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  // False once the server says this thread is read-only for us — e.g. a project
  // DM where we no longer share a project with the other person. History stays
  // visible; only the composer goes away.
  const [canPost, setCanPost] = useState(true);
  // Account state of the other side of a 1:1 thread; null for group chats.
  const [counterpartState, setCounterpartState] = useState<string | null>(null);
  // Per-message edit/delete state.
  const [menuId, setMenuId] = useState<string | null>(null);
  const [reactId, setReactId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');
  const [rowBusy, setRowBusy] = useState(false);
  const [deleteEveryoneId, setDeleteEveryoneId] = useState<string | null>(null);
  const [deletingEveryone, setDeletingEveryone] = useState(false);
  // Per-user (per-device) composer preference: when on, Enter sends and
  // Shift+Enter inserts a newline; when off (default), Enter is a newline and
  // Shift+Enter sends. Persisted in localStorage so it sticks for this user.
  const [enterToSend, setEnterToSend] = useState(false);
  const lightbox = useImageLightbox();

  // One gallery per conversation: the viewer's arrows then walk every image in
  // the thread instead of dead-ending on the one that happened to be tapped.
  const galleryImages = useMemo(
    () =>
      messages
        .filter((m) => !m.deleted)
        .flatMap((m) => m.attachments)
        .filter((a) => a.contentType.startsWith('image/'))
        .map((a) => ({ src: `/api/messages/attachments/${a.id}`, filename: a.filename })),
    [messages]
  );
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // Load the saved Enter-to-send preference once on mount. Wrapped like every
  // other access in this component: with site data blocked (or inside a
  // sandboxed iframe) the `localStorage` *getter* itself throws, and a throw in
  // an effect unmounts the whole thread view through the nearest error boundary
  // — i.e. no composer at all, over a stored preference.
  useEffect(() => {
    try {
      setEnterToSend(localStorage.getItem('messages-enter-to-send') === '1');
    } catch { /* ignore */ }
  }, []);
  const toggleEnterToSend = () => {
    setEnterToSend((prev) => {
      const next = !prev;
      try { localStorage.setItem('messages-enter-to-send', next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  };

  // Draft (#1871). A half-written reply is per thread and per device, so
  // localStorage is the whole store: no table, no endpoint, and nothing about an
  // unsent message ever leaves the browser. Every access is wrapped — in a
  // private window or with site data blocked even the *getter* throws, and a
  // composer that cannot remember a draft must still be a composer.
  // Keyed by viewer as well as thread: on a shared browser profile the next
  // person to sign in must not be handed the previous one's unsent text (which
  // they could then send as themselves). `signOutEverywhere()` clears the
  // session, not site data, so the key has to carry the identity itself — and
  // it is null until the session has resolved, so nothing is ever written to or
  // read from an anonymous key in the first moments of a mount.
  const draftKey = myId ? `messages-draft-${myId}-${target.kind}-${target.id}` : null;
  const draftKeyRef = useRef<string | null>(null);

  const saveDraft = useCallback((value: string) => {
    if (!draftKey) return;
    try {
      if (value) localStorage.setItem(draftKey, value);
      else localStorage.removeItem(draftKey);
    } catch { /* ignore */ }
  }, [draftKey]);

  // Every write to the box goes through here, so the draft is saved by the same
  // action that changed it. An effect keyed on `body` would instead run once
  // more right after the thread changed — with the previous thread's text still
  // in state — and stamp it onto the new thread's key.
  const changeBody = useCallback((value: string) => {
    setBody(value);
    saveDraft(value);
  }, [saveDraft]);

  useEffect(() => {
    if (!draftKey) return;
    const previous = draftKeyRef.current;
    draftKeyRef.current = draftKey;
    let saved = '';
    try { saved = localStorage.getItem(draftKey) ?? ''; } catch { /* ignore */ }
    // Switching threads without remounting: show this thread's draft, or an
    // empty box. The other thread's text is already stored under its own key.
    if (previous !== null && previous !== draftKey) { setBody(saved); return; }
    // First run for this mount: never overwrite something already typed — the
    // box is interactive before effects have run.
    if (saved) setBody((current) => current || saved);
  }, [draftKey]);

  // Typing indicator (#1871). Outbound: a throttled POST that stores nothing.
  // Inbound: a senderId -> expiry map this component prunes itself.
  const lastTypingSentRef = useRef(0);
  const [typingUntil, setTypingUntil] = useState<Record<string, number>>({});

  const notifyTyping = useCallback(() => {
    const now = Date.now();
    if (now - lastTypingSentRef.current < TYPING_THROTTLE_MS) return;
    lastTypingSentRef.current = now;
    void fetch('/api/realtime/typing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [target.kind === 'relation' ? 'relationId' : 'conversationId']: target.id }),
    }).catch(() => { /* a courtesy signal must never surface as an error */ });
  }, [target.kind, target.id]);

  // A thread switch inside one mount must not inherit the previous thread's
  // indicator (it would linger for up to TYPING_EXPIRY_MS), and the outbound
  // throttle starts fresh so the first keystroke in the new thread is announced.
  useEffect(() => {
    setTypingUntil({});
    lastTypingSentRef.current = 0;
  }, [target.kind, target.id]);

  const someoneTyping = Object.keys(typingUntil).length > 0;
  useEffect(() => {
    if (!someoneTyping) return;
    const timer = setInterval(() => {
      setTypingUntil((prev) => {
        const now = Date.now();
        const live = Object.entries(prev).filter(([, until]) => until > now);
        // Hand the same object back when nothing expired, so this does not
        // re-render the whole thread once a second.
        return live.length === Object.keys(prev).length ? prev : Object.fromEntries(live);
      });
    }, 1_000);
    return () => clearInterval(timer);
  }, [someoneTyping]);

  // Canned responses (#1871). The pool is fetched once, the first time somebody
  // opens the picker — it is a convenience most people never touch, and loading
  // it with the thread would put a query on every thread open for nothing.
  // `null` means "not fetched yet"; `[]` means "fetched, and empty".
  const [canned, setCanned] = useState<MessageTemplateDto[] | null>(null);
  const [cannedOpen, setCannedOpen] = useState(false);
  const [cannedQuery, setCannedQuery] = useState('');

  const toggleCanned = useCallback(() => {
    setCannedOpen((prev) => !prev);
    setCanned((current) => {
      if (current !== null) return current;
      // Marked as fetched immediately so a double-click cannot fire two loads.
      void (async () => {
        try {
          const res = await fetch('/api/message-templates');
          setCanned(res.ok ? ((await res.json()).templates ?? []) : []);
        } catch {
          setCanned([]);
        }
      })();
      return [];
    });
  }, []);

  const insertCanned = (tpl: MessageTemplateDto) => {
    // Resolved in the *writer's* locale: they are about to send this under their
    // own name, so they have to be able to read it (src/lib/messageTemplates.ts).
    const text = resolveMessageTemplateText(tpl, locale);
    // Appended, never replacing. "Half a sentence of my own plus the standard
    // paragraph" is the normal case, and throwing away typed text to make room
    // for a template would be the one unforgivable outcome here.
    changeBody(body ? `${body}\n\n${text}` : text);
    setCannedOpen(false);
    setCannedQuery('');
    bodyRef.current?.focus();
    // Ranking only, and best-effort: a counter that missed a tick must never
    // cost anyone their reply, so the failure is swallowed.
    void fetch(`/api/message-templates/${tpl.id}/use`, { method: 'POST' }).catch(() => {});
    // Reflect the bump locally so the list keeps its most-used-first order
    // without a refetch.
    setCanned((prev) =>
      prev
        ? [...prev.map((c) => (c.id === tpl.id ? { ...c, useCount: c.useCount + 1 } : c))].sort(
            (a, b) => b.useCount - a.useCount
          )
        : prev
    );
  };

  const cannedQ = cannedQuery.trim().toLowerCase();
  const cannedList = (canned ?? []).filter(
    (tpl) => !cannedQ || resolveMessageTemplateText(tpl, locale).toLowerCase().includes(cannedQ)
  );

  // Enter/Shift+Enter behaviour depends on the preference above; ArrowUp on an
  // empty box edits your last message (WhatsApp/Slack/Telegram style).
  const onComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowUp' && !body && editId === null) {
      const lastMine = [...messages].reverse().find((m) => m.senderId === myId && !m.deleted);
      if (lastMine) {
        e.preventDefault();
        setMenuId(null);
        setReactId(null);
        setEditId(lastMine.id);
        setEditBody(lastMine.body);
      }
      return;
    }
    if (e.key !== 'Enter') return;
    const shouldSend = enterToSend ? !e.shiftKey : e.shiftKey;
    if (shouldSend) {
      e.preventDefault();
      if (!sending) void send();
    }
    // otherwise let the textarea insert a newline (default behaviour)
  };

  const load = useCallback(async () => {
    const query = target.kind === 'relation' ? `relationId=${target.id}` : `conversationId=${target.id}`;
    const res = await fetch(`/api/messages?${query}`);
    if (res.status === 403) { setForbidden(true); setLoading(false); return; }
    const d = await res.json();
    setMessages(d.messages ?? []);
    // A mentorship thread answers with mentor/mentee; a conversation with a
    // participants array. Normalize both to one list.
    setParties(d.participants ?? [d.mentor, d.mentee].filter(Boolean));
    setMentorId(d.mentorId ?? d.mentor?.id ?? null);
    setGroup(d.type === 'GROUP' ? { projectId: d.projectId ?? null, projectName: d.projectName ?? null } : null);
    setCanPost(d.canPost !== false);
    setCounterpartState(d.counterpartState ?? null);
    setLoading(false);
  }, [target.kind, target.id]);

  useEffect(() => { load(); }, [load]);

  // Live thread (#1464). The stream carries ids, not bodies, so a signal for
  // *this* thread simply replays the authorized fetch above — which also marks
  // the new message read, exactly as opening the thread does.
  //
  // A `message` event is the fast path, never the only path, and that is what
  // keeps this self-healing: `tick` is the polling fallback and the "tab came
  // back to the foreground" nudge; `ready` is a freshly (re)connected stream,
  // which is exactly when an event may have been published while nobody was
  // listening; `unread` is the heartbeat's database re-check noticing a change.
  // None of the three says *which* thread moved, so they reload unconditionally.
  useRealtime((signal) => {
    if (signal.type === 'tick' || signal.type === 'ready' || signal.type === 'unread') { void load(); return; }
    if (signal.type !== 'message' && signal.type !== 'typing') return;
    const mine = target.kind === 'relation' ? signal.relationId === target.id : signal.conversationId === target.id;
    if (!mine) return;
    if (signal.type === 'typing') {
      // Nothing to refetch: the thread has not changed, someone is only
      // writing into it. Remember who, until it expires above.
      const who = signal.senderId;
      if (!who || who === myId) return;
      setTypingUntil((prev) => ({ ...prev, [who]: Date.now() + TYPING_EXPIRY_MS }));
      return;
    }
    void load();
  });
  // `block: 'end'` keeps this inside the bubble scroller instead of nudging the
  // page: on mobile the list is the only scrollable box (see MessagesShell).
  //
  // Keyed on the *last message id*, not the array: `load()` now also runs on a
  // live signal and on every poll tick (#1464), each of which produces a fresh
  // array with identical contents. Scrolling on that would drag someone reading
  // back through the thread down to the bottom every few seconds.
  const lastMessageId = messages.length ? messages[messages.length - 1].id : null;
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: scrollBehavior(), block: 'end' });
  }, [lastMessageId]);

  const addFiles = (list: FileList | File[]) => {
    const picked = Array.from(list).filter(Boolean);
    if (picked.length === 0) return;
    setAttachments((prev) => [...prev, ...picked.map((file) => ({ file, url: URL.createObjectURL(file) }))]);
  };

  const removeAttachment = (idx: number) => {
    setAttachments((prev) => {
      const next = [...prev];
      const [gone] = next.splice(idx, 1);
      if (gone) URL.revokeObjectURL(gone.url);
      return next;
    });
  };

  // Paste an image straight from the clipboard into the reply box.
  const onPaste = (e: React.ClipboardEvent) => {
    const imgs = Array.from(e.clipboardData.items)
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f)
      // Clipboard images are often named "image.png"; make them unique.
      .map((f) => new File([f], `pasted-${messages.length}-${f.name || 'image.png'}`, { type: f.type }));
    if (imgs.length) { e.preventDefault(); addFiles(imgs); }
  };

  const send = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!body.trim() && attachments.length === 0) return;
    setSending(true);
    setAttachError('');
    try {
      let res: Response;
      if (attachments.length > 0) {
        const fd = new FormData();
        fd.append(target.kind === 'relation' ? 'relationId' : 'conversationId', target.id);
        fd.append('body', body);
        attachments.forEach((a) => fd.append('file', a.file));
        res = await fetch('/api/messages', { method: 'POST', body: fd });
      } else {
        res = await fetch('/api/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [target.kind === 'relation' ? 'relationId' : 'conversationId']: target.id, body }),
        });
      }
      if (res.ok) {
        setBody('');
        // Sent, so there is no draft left to restore on the next visit.
        saveDraft('');
        attachments.forEach((a) => URL.revokeObjectURL(a.url));
        setAttachments([]);
        if (fileRef.current) fileRef.current.value = '';
        await load();
      } else {
        const data = await res.json().catch(() => ({}));
        setAttachError(data.error || t.messages.sendFailed);
      }
    } finally {
      setSending(false);
    }
  };

  const react = async (id: string, emoji: string) => {
    setReactId(null);
    try {
      const res = await fetch(`/api/messages/${id}/reactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji }),
      });
      if (res.ok) await load();
    } catch { /* non-critical; ignore */ }
  };

  const startEdit = (m: Msg) => { setMenuId(null); setEditId(m.id); setEditBody(m.body); };
  const cancelEdit = () => { setEditId(null); setEditBody(''); };

  const saveEdit = async (id: string) => {
    if (!editBody.trim()) return;
    setRowBusy(true);
    try {
      const res = await fetch(`/api/messages/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: editBody }),
      });
      if (res.ok) { cancelEdit(); await load(); }
      else setAttachError(t.messages.editFailed);
    } catch { setAttachError(t.messages.editFailed); }
    finally { setRowBusy(false); }
  };

  const performDelete = async (id: string, scope: 'everyone' | 'me') => {
    setRowBusy(true);
    try {
      const res = await fetch(`/api/messages/${id}?scope=${scope}`, { method: 'DELETE' });
      if (res.ok) await load();
      else setAttachError(t.messages.deleteFailed);
    } catch { setAttachError(t.messages.deleteFailed); }
    finally { setRowBusy(false); }
  };

  const remove = (id: string, scope: 'everyone' | 'me') => {
    setMenuId(null);
    if (scope === 'everyone') { setDeleteEveryoneId(id); return; }
    void performDelete(id, 'me');
  };

  const confirmDeleteEveryone = async () => {
    if (!deleteEveryoneId || deletingEveryone) return;
    setDeletingEveryone(true);
    try {
      await performDelete(deleteEveryoneId, 'everyone');
    } finally {
      setDeletingEveryone(false);
      setDeleteEveryoneId(null);
    }
  };

  const nameFor = (id: string) => parties.find((p) => p.id === id)?.fullName ?? '—';
  // Resolved through the participants already loaded for the thread; an id we
  // cannot name (someone added to a group chat since the last fetch) is dropped
  // rather than announced as a dash.
  const typingNames = Object.keys(typingUntil)
    .map((id) => (parties.find((p) => p.id === id)?.fullName ?? '').trim().split(/\s+/)[0] ?? '')
    .filter(Boolean);
  // Header shows the other side (the only other party in a 1:1 thread).
  const other = parties.find((p) => p.id !== myId) ?? null;
  // A group chat has no "other side" — it is named after its project.
  const threadTitle = group ? group.projectName ?? t.messages.groupChat : other?.fullName;
  // Only conversation threads can host a call (#1055): membership is derived
  // from ConversationParticipant, so either side may start one. The legacy
  // relation thread is left out — its mentee would be refused server-side
  // anyway (relations are mentor-scoped), and a button that always fails is
  // worse than no button. Mentors reach 1:1 calls from the mentee card.
  const startMeetingTarget: MeetingTarget | null =
    target.kind === 'conversation' ? { conversationId: target.id } : null;
  // On mobile the shell's header is the only title, so it carries the name.
  useMessagesHeaderTitle(threadTitle);

  // Nothing has been said in this thread yet, so offer a way in instead of an
  // empty box (#1130). The mentor gets welcome-flavoured openers — they are the
  // one who reaches out first; everyone else gets neutral ones. Group chats are
  // left alone: there is no single person to greet.
  const openers = t.messages.openers;
  const otherFirstName = (other?.fullName ?? '').trim().split(/\s+/)[0] ?? '';
  const suggestions =
    messages.length > 0 || !canPost || group || !otherFirstName
      ? []
      : (!!myId && mentorId === myId
          ? [openers.welcome, openers.introCall, openers.goals]
          : [openers.hello, openers.intro, openers.question]
        ).map((o) => ({ label: o.label, text: o.text.replace('{name}', otherFirstName) }));

  // Fill the box rather than send: the sender stays in control of the wording.
  // No explicit caret handling — writing a new `value` into a textarea puts the
  // caret at the end by itself, which is where an unfinished opener continues.
  const applySuggestion = (text: string) => {
    changeBody(text);
    bodyRef.current?.focus();
  };

  const partyRole = (p: Party) =>
    p.role === 'MENTEE'
      ? p.functionalRole
        ? (t.projects.functionalRoles as Record<string, string>)[p.functionalRole]
        : t.projects.roleMentee
      : p.role === 'OWNER'
        ? t.projects.roleOwner
        : p.role === 'MENTOR'
          ? t.projects.roleMentorMember
          : null;

  if (loading) return <p className="text-center py-12 text-gray-400">{t.common.loading}</p>;
  if (forbidden) return <p className="text-center py-12 text-gray-400">{t.common.notFound}</p>;

  return (
    // Below lg this fills the shell's content area exactly: only the bubble list
    // scrolls, and the composer stays visible without any document scroll.
    <div className="flex h-full min-h-0 flex-col lg:h-auto lg:block">
      {/* On mobile the shell header is the heading (and names the thread), so this
          block would be a duplicate title eating a third of a phone screen. */}
      {!narrow && (
        <div className="mb-6 flex items-start gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-gray-900 mb-1">{t.messages.title}</h1>
            <p className="flex items-center gap-2 text-gray-500">
              {/* A 1:1 thread is named after a person, so the name is a way to
                  reach them (#1166); a group room is named after its project. */}
              {!group && other ? (
                <PersonHoverCard personId={other.id} name={other.fullName} className="truncate" />
              ) : (
                <span className="truncate">{threadTitle}</span>
              )}
              {/* 1:1 only — a group room has no single language to name. */}
              {!group && other && <LanguageBadge language={other.preferredLanguage} />}
            </p>
          </div>
          {startMeetingTarget && (
            <StartMeetingButton
              className="ml-auto flex-shrink-0"
              target={startMeetingTarget}
              defaultTitle={threadTitle ?? undefined}
              testId="start-meeting-conversation"
            />
          )}
        </div>
      )}

      {/* On a phone the header above is hidden, so the action needs its own row —
          otherwise starting a call from a chat is desktop-only. */}
      {narrow && startMeetingTarget && (
        <div className="mb-2 flex justify-end">
          <StartMeetingButton
            target={startMeetingTarget}
            defaultTitle={threadTitle ?? undefined}
            testId="start-meeting-conversation-mobile"
          />
        </div>
      )}

      {/* Who is in this room. A group chat used to be an anonymous thread: you
          could read the names on the bubbles but never see the roster (#51). */}
      {group && (
        <div className="mb-3 rounded-xl border border-gray-200 bg-white p-3 text-sm dark:border-gray-800 dark:bg-gray-900" data-testid="group-participants">
          <div className="flex items-center gap-2">
            <Users2 className="h-4 w-4 shrink-0 text-gray-400" />
            <button
              type="button"
              onClick={() => setShowParties((v) => !v)}
              className="font-medium text-gray-700 hover:text-blue-600 dark:text-gray-200"
              aria-expanded={showParties}
              data-testid="group-participants-toggle"
            >
              {t.messages.participantCount.replace('{n}', String(parties.length))}
            </button>
            {group.projectId && (
              <a href={`/projects/${group.projectId}`} className="ml-auto inline-flex items-center gap-1 text-xs text-blue-600 hover:underline">
                <FolderOpen className="h-3.5 w-3.5" /> {t.messages.openProject}
              </a>
            )}
          </div>
          {showParties && (
            <ul className="mt-2 space-y-1">
              {parties.map((p) => (
                <li key={p.id} className="flex items-center gap-2 text-xs">
                  <span className="text-gray-800 dark:text-gray-200">
                    <PersonHoverCard personId={p.id} name={p.fullName} />
                    {p.id === myId && <span className="text-gray-400"> · {t.messages.you}</span>}
                  </span>
                  {partyRole(p) && <span className="rounded-full bg-gray-100 px-2 py-0.5 text-gray-500 dark:bg-gray-800">{partyRole(p)}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <Card className="mb-3 flex min-h-0 flex-1 flex-col overflow-hidden p-3 lg:mb-4 lg:block lg:p-6">
        {messages.length === 0 ? (
          <p className="text-center py-10 text-gray-400 text-sm">{t.messages.empty}</p>
        ) : (
          <div data-testid="thread-messages" className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain lg:max-h-[55vh] lg:flex-none">
            {messages.map((m) => {
              const mine = m.senderId === myId;
              return (
                <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm ${mine ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-900'}`}>
                    {!mine && <p className="text-xs font-medium mb-0.5 opacity-70">{nameFor(m.senderId)}</p>}
                    {m.deleted ? (
                      <p className={`italic ${mine ? 'text-blue-100' : 'text-gray-400'}`}>{t.messages.deletedPlaceholder}</p>
                    ) : editId === m.id ? (
                      <div className="space-y-1.5">
                        <Textarea
                          value={editBody}
                          onChange={(e) => setEditBody(e.target.value)}
                          rows={2}
                          maxLength={TEXT_LIMITS.messageBody}
                          showCounter
                        />
                        <div className="flex gap-1.5">
                          <Button size="sm" onClick={() => saveEdit(m.id)} loading={rowBusy} disabled={!editBody.trim()}>{t.messages.save}</Button>
                          <Button size="sm" variant="outline" onClick={cancelEdit}>{t.messages.cancel}</Button>
                        </div>
                      </div>
                    ) : (
                      <>
                        {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
                        {m.attachments.map((a) =>
                          a.contentType.startsWith('image/') ? (
                            <button
                              key={a.id}
                              type="button"
                              onClick={() => lightbox.open(galleryImages, galleryImages.findIndex((g) => g.src === `/api/messages/attachments/${a.id}`))}
                              aria-label={t.imageViewer.view.replace('{name}', a.filename)}
                              data-testid="message-image-attachment"
                              className="mt-1.5 block rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={`/api/messages/attachments/${a.id}`} alt={a.filename} className="max-h-48 rounded-lg" />
                            </button>
                          ) : (
                            <a
                              key={a.id}
                              href={`/api/messages/attachments/${a.id}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={`flex items-center gap-1.5 mt-1.5 text-xs rounded-lg px-2 py-1.5 ${mine ? 'bg-blue-700 hover:bg-blue-800' : 'bg-white hover:bg-gray-50 border border-gray-200'}`}
                            >
                              <FileText className="h-3.5 w-3.5 flex-shrink-0" />
                              <span className="truncate">{a.filename}</span>
                              <Download className="h-3 w-3 flex-shrink-0 ml-auto" />
                            </a>
                          )
                        )}
                      </>
                    )}
                    <p className={`text-[10px] mt-1 flex items-center gap-1 ${mine ? 'text-blue-100' : 'text-gray-400'}`}>
                      {m.channel === 'EMAIL' ? '✉ ' : ''}{formatDateTime(m.createdAt, locale)}
                      {m.editedAt && !m.deleted && <span>· {t.messages.edited}</span>}
                      {mine && !m.deleted && (
                        <span
                          className="inline-flex"
                          title={m.readAt ? t.messages.read : t.messages.sent}
                          aria-label={m.readAt ? t.messages.read : t.messages.sent}
                        >
                          {m.readAt
                            ? <CheckCheck className="h-3.5 w-3.5 text-sky-300" aria-hidden />
                            : <Check className="h-3.5 w-3.5" aria-hidden />}
                        </span>
                      )}
                      {!m.deleted && editId !== m.id && (
                        <span className="ml-auto flex items-center gap-0.5">
                          <button
                            type="button"
                            onClick={() => { setReactId(reactId === m.id ? null : m.id); setMenuId(null); }}
                            aria-label={t.messages.react}
                            className={`rounded p-0.5 ${mine ? 'hover:bg-blue-700' : 'hover:bg-gray-200'}`}
                          >
                            <SmilePlus className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => { setMenuId(menuId === m.id ? null : m.id); setReactId(null); }}
                            aria-label={t.messages.messageActions}
                            className={`rounded p-0.5 ${mine ? 'hover:bg-blue-700' : 'hover:bg-gray-200'}`}
                          >
                            <MoreVertical className="h-3.5 w-3.5" />
                          </button>
                        </span>
                      )}
                    </p>

                    {/* Emoji picker */}
                    {reactId === m.id && !m.deleted && (() => {
                      const myEmoji = m.reactions.find((r) => r.mine)?.emoji;
                      return (
                        <div className="mt-1.5 flex gap-1 rounded-lg bg-white/90 border border-black/5 px-1.5 py-1 w-fit">
                          {REACTIONS.map((emoji) => (
                            <button
                              key={emoji}
                              type="button"
                              onClick={() => react(m.id, emoji)}
                              className={`text-base leading-none hover:scale-125 transition-transform rounded ${myEmoji === emoji ? 'ring-2 ring-blue-400 ring-offset-1 dark:ring-offset-gray-800' : ''}`}
                              aria-label={emoji}
                              aria-pressed={myEmoji === emoji}
                            >
                              {emoji}
                            </button>
                          ))}
                        </div>
                      );
                    })()}

                    {/* Reaction chips */}
                    {!m.deleted && m.reactions.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {m.reactions.map((r) => (
                          <button
                            key={r.emoji}
                            type="button"
                            onClick={() => {
                              if (r.mine) {
                                // Open the picker so the user can switch to a different emoji
                                // instead of immediately removing their reaction.
                                setReactId(reactId === m.id ? null : m.id);
                                setMenuId(null);
                              } else {
                                react(m.id, r.emoji);
                              }
                            }}
                            aria-pressed={r.mine}
                            className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs border ${r.mine ? 'bg-blue-100 border-blue-300 text-blue-800' : 'bg-white/90 border-black/5 text-gray-700'}`}
                          >
                            <span>{r.emoji}</span>
                            <span>{r.count}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {menuId === m.id && !m.deleted && editId !== m.id && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {mine && (
                          <button type="button" onClick={() => startEdit(m)} className="text-xs px-2 py-0.5 rounded bg-white/90 text-gray-700 hover:bg-white border border-black/5">
                            {t.messages.edit}
                          </button>
                        )}
                        <button type="button" onClick={() => remove(m.id, 'me')} className="text-xs px-2 py-0.5 rounded bg-white/90 text-gray-700 hover:bg-white border border-black/5">
                          {t.messages.deleteForMe}
                        </button>
                        {mine && (
                          <button type="button" onClick={() => remove(m.id, 'everyone')} className="text-xs px-2 py-0.5 rounded bg-white/90 text-red-600 hover:bg-white border border-black/5">
                            {t.messages.deleteForEveryone}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            <div ref={endRef} />
          </div>
        )}
      </Card>

      <div className="shrink-0" data-testid="thread-composer">
      {attachError && <p className="text-xs text-red-600 mb-2">{attachError}</p>}
      {/* The other side cannot read this. Posting still works (the message waits
          for them, and the email mirror may still land), but you should know
          before you type — silence from an unreachable account reads as being
          ignored otherwise (#1194). */}
      {counterpartState && counterpartState !== 'active' && (
        <p
          className="mb-2 rounded-lg bg-amber-50 dark:bg-amber-900/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
          data-testid="counterpart-unreachable"
        >
          {counterpartState === 'placeholder_email'
            ? t.messages.counterpartNoEmail
            : counterpartState === 'no_login'
              ? t.messages.counterpartNoLogin
              : t.messages.counterpartInactive}
        </p>
      )}
      {!canPost && (
        <p className="text-center py-3 text-sm text-gray-400" data-testid="thread-readonly">
          {t.messages.readOnlyNotice}
        </p>
      )}
      {canPost && (
      <>
      {suggestions.length > 0 && (
        <div className="mb-2" data-testid="message-suggestions">
          <p className="mb-1.5 text-xs text-gray-400">{openers.title}</p>
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((s) => (
              <button
                key={s.label}
                type="button"
                onClick={() => applySuggestion(s.text)}
                title={s.text}
                className="rounded-full border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs text-blue-700 hover:bg-blue-100 dark:border-blue-900"
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {/* Always in the DOM so the live region is registered before it has
          anything to say — a screen reader does not reliably announce an
          aria-live element that appears at the same moment as its text. When
          there is nothing to say it is `sr-only`, which keeps it out of the
          layout rather than reserving a strip above the composer. */}
      <p
        className={`text-xs text-gray-500 dark:text-gray-400 ${typingNames.length > 0 ? 'mb-1.5' : 'sr-only'}`}
        data-testid="typing-indicator"
        aria-live="polite"
      >
        {typingNames.length === 0
          ? ''
          : typingNames.length === 1
            ? t.messages.typing.replace('{name}', typingNames[0])
            : t.messages.typingMany}
      </p>
      {/* Canned responses (#1871): the reply a mentor writes forty times a
          cohort, one click, in their own language. Collapsed by default — this
          is a shortcut for the person who needs it, not furniture above
          everyone's composer. */}
      {cannedOpen && (
        <div
          className="mb-2 rounded-lg border border-gray-200 bg-white p-2 dark:border-gray-700 dark:bg-gray-900"
          data-testid="canned-panel"
        >
          <div className="mb-2 flex items-center gap-2">
            <input
              type="search"
              value={cannedQuery}
              onChange={(e) => setCannedQuery(e.target.value)}
              placeholder={t.messages.cannedSearch}
              className="min-w-0 flex-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
              data-testid="canned-search"
            />
            <button
              type="button"
              onClick={() => setCannedOpen(false)}
              aria-label={t.messages.cannedClose}
              className="shrink-0 text-gray-400 hover:text-gray-600"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {cannedList.length === 0 ? (
            <p className="px-1 py-2 text-xs text-gray-400" data-testid="canned-none">
              {t.messages.cannedNone}
            </p>
          ) : (
            <>
              <p className="mb-1.5 px-1 text-xs text-gray-400">{t.messages.cannedHint}</p>
              <ul className="max-h-52 overflow-y-auto">
                {cannedList.map((tpl) => (
                  <li key={tpl.id}>
                    <button
                      type="button"
                      onClick={() => insertCanned(tpl)}
                      title={resolveMessageTemplateText(tpl, locale)}
                      className="w-full rounded-md px-2 py-1.5 text-left text-xs text-gray-700 hover:bg-blue-50 dark:text-gray-200 dark:hover:bg-gray-800"
                      data-testid={`canned-template-${tpl.id}`}
                    >
                      {templatePreview(resolveMessageTemplateText(tpl, locale))}
                      {tpl.personal && (
                        <span className="ml-1.5 text-gray-400">· {t.messages.cannedPersonal}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      <PendingAttachmentList attachments={attachments} onRemove={removeAttachment} removeLabel={t.common.delete} />
      <MessageComposer
        body={body}
        onBodyChange={(value) => { changeBody(value); if (value) notifyTyping(); }}
        onSubmit={() => void send()}
        sending={sending}
        hasAttachments={attachments.length > 0}
        placeholder={t.messages.replyPlaceholder}
        sendLabel={t.messages.send}
        attachLabel={t.messages.attach}
        fileInputRef={fileRef}
        accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/png,image/jpeg"
        onFilesSelected={addFiles}
        onPaste={onPaste}
        onKeyDown={onComposerKeyDown}
        inputTestId="message-attachment-input"
        textareaRef={bodyRef}
        textareaTestId="message-input"
        sendTestId="message-send"
      />
      <div className="mt-1.5 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={toggleCanned}
          aria-expanded={cannedOpen}
          className="inline-flex shrink-0 items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700"
          data-testid="canned-toggle"
        >
          <MessageSquareQuote className="h-3.5 w-3.5" />
          {t.messages.canned}
        </button>
        {/* Keyboard-only hint — no room for it on a phone. */}
        <span className="hidden lg:inline text-xs text-gray-400 truncate">{t.messages.pasteHint}</span>
        <button
          type="button"
          role="switch"
          aria-checked={enterToSend}
          onClick={toggleEnterToSend}
          title={enterToSend ? t.messages.enterToSendOnHint : t.messages.enterToSendOffHint}
          className="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 shrink-0"
        >
          <span className={`relative inline-block h-4 w-7 shrink-0 rounded-full transition-colors ${enterToSend ? 'bg-blue-600' : 'bg-gray-300'}`}>
            <span className={`absolute top-0.5 left-0.5 h-3 w-3 rounded-full bg-white transition-transform ${enterToSend ? 'translate-x-3' : 'translate-x-0'}`} />
          </span>
          {t.messages.enterToSend}
        </button>
      </div>
      </>
      )}
      </div>
      <ConfirmDialog
        open={deleteEveryoneId !== null}
        message={t.messages.deleteEveryoneConfirm}
        cancelLabel={t.messages.cancel}
        confirmLabel={t.messages.deleteForEveryone}
        variant="danger"
        loading={deletingEveryone}
        onConfirm={confirmDeleteEveryone}
        onCancel={() => setDeleteEveryoneId(null)}
      />
      <ImageLightbox {...lightbox.lightboxProps} />
    </div>
  );
}
