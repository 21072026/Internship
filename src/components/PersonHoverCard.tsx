'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Mail, MessageSquare, UserRound } from 'lucide-react';
import { useT } from '@/i18n/client';
import { useStageLabel } from '@/lib/pipelineStagesClient';
import { LanguageBadge } from '@/components/LanguageBadge';
import { personHref } from '@/lib/personHref';

// A small card behind a person's name (#1166).
//
// Names were plain text nearly everywhere: you could read who someone was but
// not reach them. A hover card answers "who is this, and what can I do about
// them?" without leaving the page — which matters most on the screens where a
// name appears *inside a form* (the bulk email composer), where navigating away
// would throw away half-typed work.
//
// Data is fetched on first open and cached per person id for the page's
// lifetime, so sweeping the mouse down a list of twenty names costs at most
// twenty requests, and re-hovering costs none.

interface PersonCardData {
  id: string;
  fullName: string;
  role: string;
  preferredLanguage: string | null;
  avatarUrl: string | null;
  university: string | null;
  department: string | null;
  targetPosition: string | null;
  pipelineStatus: string | null;
  mentorName: string | null;
  companyName: string | null;
  email: string | null;
}

// Module-level: shared by every card on the page. `null` is a cached miss (no
// permission / no such person), so a name we are not allowed to look up is not
// retried on every hover.
const cache = new Map<string, PersonCardData | null>();

const OPEN_DELAY_MS = 250;
const CLOSE_DELAY_MS = 150;

export function PersonHoverCard({
  personId,
  name,
  role,
  className = '',
  children,
}: {
  personId: string;
  /** Shown as the trigger when no children are given. */
  name?: string;
  /** The person's role, used to pick the profile route without a round trip. */
  role?: string | null;
  className?: string;
  children?: React.ReactNode;
}) {
  const t = useT();
  const router = useRouter();
  const { data: session } = useSession();
  const stageLabel = useStageLabel();
  const cardId = useId();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<PersonCardData | null | undefined>(cache.get(personId));
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  };
  useEffect(() => clearTimers, []);

  // Measured in a layout effect rather than in the event handler: reading the
  // rect at event time can catch a layout that has not settled (these lists are
  // client-fetched and reflow as they fill), which put the card in the wrong
  // corner of the screen. Running after the open render reads the real geometry.
  useLayoutEffect(() => {
    if (!open) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // position: fixed off the trigger's rect — the card must escape the
    // `overflow-y-auto` panels several of these lists live inside, which would
    // otherwise clip it.
    const width = 288; // w-72
    setPosition({
      top: rect.bottom + 6,
      // Keep it on screen when the name sits near the right edge.
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
    });
  }, [open]);

  const show = useCallback(() => {
    setOpen(true);
    if (cache.has(personId)) {
      setData(cache.get(personId));
      return;
    }
    fetch(`/api/people/${personId}/card`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        const person: PersonCardData | null = body?.person ?? null;
        cache.set(personId, person);
        setData(person);
      })
      .catch(() => {
        // Not cached: a network blip should not permanently blank the card.
        setData(null);
      });
  }, [personId]);

  const hide = () => setOpen(false);

  const onEnter = () => {
    clearTimers();
    // A short delay so dragging the pointer across a list does not flash a card
    // for every name it crosses.
    openTimer.current = setTimeout(show, OPEN_DELAY_MS);
  };
  const onLeave = () => {
    clearTimers();
    closeTimer.current = setTimeout(hide, CLOSE_DELAY_MS);
  };

  // Touch devices have no hover at all, so there the trigger is a tap. Handled
  // via onClick rather than a pointer-type check: a click also arrives from
  // keyboard activation, which is exactly when the card should open too.
  //
  // It opens, it never toggles. A real pointer click focuses the trigger first,
  // and `onFocus` has already opened the card by the time `onClick` runs — a
  // toggle here would therefore close it again on every desktop click, which is
  // exactly what happened before this comment existed. Closing is left to
  // pointer-leave, Escape, and the outside-click below.
  //
  // preventDefault matters on the surfaces where the trigger sits inside a
  // <label> (the bulk email recipient rows): without it, opening a card would
  // also tick that recipient's checkbox.
  const onClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    clearTimers();
    show();
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    // A scroll invalidates the fixed position we measured, and re-measuring on
    // every frame is not worth it for a hover affordance.
    // Tapping elsewhere dismisses it — on touch there is no pointer-leave to
    // rely on, so without this a card opened by tap would have no way to close.
    const onOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if ((target as Element).closest?.('[data-testid="person-card"]')) return;
      hide();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onOutside);
    window.addEventListener('scroll', hide, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onOutside);
      window.removeEventListener('scroll', hide, true);
    };
  }, [open]);

  // The caller's `role` hint stands in until the fetch lands, so the profile
  // link is right from the first paint on the surfaces that already know what
  // they are rendering; the loaded record wins once it arrives.
  const href = personHref(session?.user?.role, { id: personId, role: data?.role ?? role });
  const label = name ?? data?.fullName ?? '';
  const roleLabel = (r: string) =>
    ({
      ADMIN: t.personCard.roleAdmin,
      MENTOR: t.personCard.roleMentor,
      MENTEE: t.personCard.roleMentee,
      COMPANY: t.personCard.roleCompany,
      SOURCE: t.personCard.roleSource,
    })[r] ?? r;

  // Same create-or-get flow the profile quick actions use (UserQuickActions),
  // so a chat opened from a card is the pair's one conversation (#1156) rather
  // than a second thread.
  const openChat = async () => {
    try {
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: personId }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.conversation?.id) router.push(`/messages/c/${body.conversation.id}`);
    } catch {
      // A failed chat open should leave the card as it was, not blow up the page.
    }
  };

  return (
    <>
      <span
        ref={triggerRef}
        data-testid={`person-trigger-${personId}`}
        aria-describedby={open ? cardId : undefined}
        tabIndex={0}
        role="button"
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onFocus={show}
        onBlur={onLeave}
        onClick={onClick}
        className={`cursor-pointer underline decoration-dotted underline-offset-2 hover:decoration-solid focus:outline-none focus:ring-2 focus:ring-blue-300 rounded ${className}`}
      >
        {children ?? label}
      </span>

      {open && position && (
        <div
          id={cardId}
          role="dialog"
          data-testid="person-card"
          onMouseEnter={clearTimers}
          onMouseLeave={onLeave}
          style={{ top: position.top, left: position.left }}
          className="fixed z-50 w-72 rounded-xl border border-gray-200 bg-white p-3 shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          {data === undefined ? (
            <p className="text-xs text-gray-400">{t.common.loading}</p>
          ) : data === null ? (
            <p className="text-xs text-gray-400" data-testid="person-card-unavailable">
              {t.personCard.unavailable}
            </p>
          ) : (
            <>
              <div className="flex items-start gap-2">
                {data.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={data.avatarUrl} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" />
                ) : (
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800">
                    <UserRound className="h-4 w-4 text-gray-400" />
                  </span>
                )}
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100">
                    <span className="truncate">{data.fullName}</span>
                    {/* Which language to write to them in (#1164). */}
                    <LanguageBadge language={data.preferredLanguage} />
                  </p>
                  <p className="text-xs text-gray-500">{roleLabel(data.role)}</p>
                </div>
              </div>

              <div className="mt-2 space-y-0.5 text-xs text-gray-600 dark:text-gray-300">
                {data.pipelineStatus && <p>{stageLabel(data.pipelineStatus)}</p>}
                {data.mentorName && (
                  <p>
                    {t.candidates.mentor}: {data.mentorName}
                    {data.companyName && ` · ${data.companyName}`}
                  </p>
                )}
                {data.university && (
                  <p className="truncate">
                    {data.university}
                    {data.department && ` · ${data.department}`}
                  </p>
                )}
                {data.targetPosition && <p className="truncate">{data.targetPosition}</p>}
              </div>

              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                {href && (
                  <Link
                    href={href}
                    data-testid="person-card-profile"
                    className="inline-flex items-center gap-1 rounded-md bg-blue-50 px-2 py-1 text-blue-700 hover:bg-blue-100 dark:!bg-blue-900/40 dark:!text-blue-200"
                  >
                    <UserRound className="h-3.5 w-3.5" />
                    {t.personCard.openProfile}
                  </Link>
                )}
                {session?.user?.id !== data.id && (
                  <button
                    type="button"
                    onClick={openChat}
                    data-testid="person-card-message"
                    className="inline-flex items-center gap-1 rounded-md bg-gray-100 px-2 py-1 text-gray-700 hover:bg-gray-200 dark:!bg-gray-800 dark:!text-gray-200"
                  >
                    <MessageSquare className="h-3.5 w-3.5" />
                    {t.personCard.message}
                  </button>
                )}
                {data.email && (
                  <a
                    href={`mailto:${data.email}`}
                    data-testid="person-card-email"
                    className="inline-flex items-center gap-1 rounded-md bg-gray-100 px-2 py-1 text-gray-700 hover:bg-gray-200 dark:!bg-gray-800 dark:!text-gray-200"
                  >
                    <Mail className="h-3.5 w-3.5" />
                    {t.personCard.email}
                  </a>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
