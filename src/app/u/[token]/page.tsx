'use client';

import { use, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Lock, MailCheck, MailX, Undo2, XCircle } from 'lucide-react';
import { useT } from '@/i18n/client';
import type { EmailGroupId } from '@/lib/emailGroups';

// Landing page for the unsubscribe link in every non-essential e-mail footer
// (#1290). One click in the mail, and by the time this page has painted the
// person is already unsubscribed: no sign-in, no Save button, no confirmation
// step. That is the whole point — an opt-out that asks you to log in first is
// an opt-out most people give up on, and the ones who don't reach for the
// "mark as spam" button instead, which costs the sending domain far more than
// the mail was ever worth.
//
// The unsubscribe runs from the browser rather than from the link itself,
// because mail clients and corporate link scanners (Outlook Safe Links,
// antivirus gateways) fetch every URL in a message on arrival. A mutating GET
// would unsubscribe people who never clicked; a scanner does not execute
// scripts, so doing the work here keeps one-click UX without the phantom
// clicks. Gmail's own RFC 8058 one-click uses the separate POST-only endpoint
// at /api/unsubscribe/one-click, which is why THIS page can be a plain GET.
//
// The signed token in the path IS the credential, and it carries a scope: a
// single group (auto-applied on mount) or 'all' (the preference-centre link
// from the footer's second anchor, which must NOT unsubscribe anything on its
// own — somebody who clicks "manage my preferences" is asking to choose, not
// to be cut off). The server decides which of the two this is, so the page
// needs exactly one round trip either way.

type GroupState = { id: EmailGroupId; enabled: boolean; essential: boolean };

type Phase =
  | { state: 'pending' }
  | { state: 'ready'; group: string; applied: boolean }
  | { state: 'error'; message: string };

type UnsubResponse = {
  ok?: boolean;
  group?: string;
  applied?: boolean;
  emailNotifications?: boolean;
  groups?: GroupState[];
  error?: string;
  gone?: boolean;
};

export default function UnsubscribePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const t = useT();

  const [phase, setPhase] = useState<Phase>({ state: 'pending' });
  const [groups, setGroups] = useState<GroupState[]>([]);
  const [masterOff, setMasterOff] = useState(false);
  const [busyGroup, setBusyGroup] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);

  // React StrictMode mounts effects twice in development. Without this guard the
  // second run would fire a second unsubscribe POST — harmless here because the
  // write is idempotent, but it would also double the ActivityLog row and make
  // the audit trail lie about how many times the link was used.
  const fired = useRef(false);

  // Deps are deliberately [token] and nothing else. useT() returns a fresh
  // object on every render, so listing `t` here would re-run the effect on every
  // render forever — a trap this repo has already been caught by. Every string
  // below is translated at render time instead, which is also what makes a
  // language change repaint this page without re-POSTing anything.
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;

    fetch('/api/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        const data: UnsubResponse = await res.json().catch(() => ({}));
        if (!res.ok) {
          setPhase({ state: 'error', message: data.gone ? 'gone' : 'invalid' });
          return;
        }
        setGroups(Array.isArray(data.groups) ? data.groups : []);
        setMasterOff(data.emailNotifications === false);
        setPhase({
          state: 'ready',
          group: data.group ?? 'all',
          applied: data.applied === true,
        });
      })
      .catch(() => setPhase({ state: 'error', message: 'invalid' }));
  }, [token]);

  const labels = t.emailGroups as Record<string, { name: string; desc: string } | undefined>;
  const groupName = (id: string) => labels[id]?.name ?? id;
  const groupDesc = (id: string) => labels[id]?.desc ?? '';

  /** The scoped group's live state — what drives "unsubscribed" vs "back on". */
  const scopeGroup = phase.state === 'ready' ? phase.group : null;
  const scopeState = groups.find((g) => g.id === scopeGroup);
  // Derived rather than stored: flipping the same group's switch in the
  // preference centre below has to change this card too, or the page would
  // still be claiming "you are unsubscribed" about mail it just re-enabled.
  const scopeOff = !!scopeState && !scopeState.enabled;

  /** Instant save of one group — the only write the preference centre does. */
  const setGroupEnabled = async (id: EmailGroupId, enabled: boolean) => {
    const before = groups;
    setGroups((prev) => prev.map((g) => (g.id === id ? { ...g, enabled } : g)));
    setSaveFailed(false);
    setBusyGroup(id);
    try {
      const res = await fetch('/api/unsubscribe/prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, group: id, enabled }),
      });
      if (!res.ok) throw new Error('save failed');
      const data: UnsubResponse = await res.json().catch(() => ({}));
      if (Array.isArray(data.groups)) setGroups(data.groups);
      if (typeof data.emailNotifications === 'boolean') setMasterOff(!data.emailNotifications);
    } catch {
      // Optimistic UI, so a failed save has to be visibly taken back: a switch
      // that stays flipped after the write failed is worse than no switch.
      setGroups(before);
      setSaveFailed(true);
    } finally {
      setBusyGroup(null);
    }
  };

  /** Undo / redo of the scoped group, through the token's own endpoint. */
  const flipScope = async (action: 'unsubscribe' | 'resubscribe') => {
    if (!scopeGroup) return;
    setSaveFailed(false);
    setBusyGroup(scopeGroup);
    try {
      const res = await fetch('/api/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, action }),
      });
      if (!res.ok) throw new Error('flip failed');
      const data: UnsubResponse = await res.json().catch(() => ({}));
      if (Array.isArray(data.groups)) setGroups(data.groups);
      if (typeof data.emailNotifications === 'boolean') setMasterOff(!data.emailNotifications);
    } catch {
      setSaveFailed(true);
    } finally {
      setBusyGroup(null);
    }
  };

  const toggles = groups.filter((g) => !g.essential);
  const essentials = groups.filter((g) => g.essential);

  // The preference centre is the only heading on the page when the token was a
  // "manage my preferences" link, so it takes the h1 in that case — an axe scan
  // (and a screen reader's heading list) treats a page whose top heading is an
  // h2 as a page with a missing title.
  const CenterHeading = phase.state === 'ready' && phase.applied ? 'h2' : 'h1';

  return (
    <main id="main-content" className="min-h-screen bg-gray-50 dark:bg-gray-950 px-4 py-10 sm:py-16">
      <div className="mx-auto w-full max-w-2xl space-y-6">
        {phase.state === 'pending' && (
          // Two data-testid spellings per state on purpose: the shared contract
          // for this feature names them `unsub-*`, and the page-level e2e specs
          // were written against `unsubscribe-*`. The outer element carries the
          // long alias so either locator resolves to exactly one node.
          <div
            data-testid="unsubscribe-pending"
            className="rounded-2xl bg-white dark:bg-gray-900 p-6 sm:p-8 text-center shadow-sm"
          >
            <p data-testid="unsub-pending" className="text-sm text-gray-500 dark:text-gray-400">
              {t.unsubscribe.working}
            </p>
          </div>
        )}

        {phase.state === 'error' && (
          <div
            data-testid="unsubscribe-invalid"
            className="rounded-2xl bg-white dark:bg-gray-900 p-6 sm:p-8 text-center shadow-sm"
          >
            <div data-testid="unsub-error">
              <XCircle className="mx-auto mb-3 h-10 w-10 text-red-600" aria-hidden />
              <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {t.unsubscribe.failedTitle}
              </h1>
              <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                {phase.message === 'gone' ? t.unsubscribe.gone : t.unsubscribe.invalid}
              </p>
            </div>
            <Link
              href="/account"
              data-testid="unsub-open-settings"
              className="mt-6 inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              {t.unsubscribe.openSettings}
            </Link>
          </div>
        )}

        {phase.state === 'ready' && phase.applied && (
          <div className="rounded-2xl bg-white dark:bg-gray-900 p-6 sm:p-8 text-center shadow-sm">
            {scopeOff ? (
              <div data-testid="unsubscribe-done">
                <div data-testid="unsub-done">
                  <MailX className="mx-auto mb-3 h-10 w-10 text-green-600" aria-hidden />
                  <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                    {t.unsubscribe.doneTitle}
                  </h1>
                  <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                    {t.unsubscribe.doneBody.replace('{group}', groupName(phase.group))}
                  </p>
                </div>
                <div data-testid="unsubscribe-undo" className="mt-6">
                  <button
                    type="button"
                    data-testid="unsub-undo"
                    disabled={busyGroup !== null}
                    onClick={() => flipScope('resubscribe')}
                    className="inline-flex items-center gap-2 rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-60"
                  >
                    <Undo2 className="h-4 w-4" aria-hidden />
                    {t.unsubscribe.undo}
                  </button>
                </div>
              </div>
            ) : (
              <div data-testid="unsub-undone">
                <MailCheck className="mx-auto mb-3 h-10 w-10 text-blue-600" aria-hidden />
                <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                  {t.unsubscribe.undoneTitle}
                </h1>
                <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                  {t.unsubscribe.undoneBody.replace('{group}', groupName(phase.group))}
                </p>
                <button
                  type="button"
                  data-testid="unsub-redo"
                  disabled={busyGroup !== null}
                  onClick={() => flipScope('unsubscribe')}
                  className="mt-6 inline-flex items-center gap-2 rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-60"
                >
                  <MailX className="h-4 w-4" aria-hidden />
                  {t.unsubscribe.footerUnsubscribe.replace('{group}', groupName(phase.group))}
                </button>
              </div>
            )}
          </div>
        )}

        {/* The full preference centre, inline on the same page. Somebody who was
            annoyed enough to click "unsubscribe" is exactly the person we should
            show the narrower switches to — "stop the reminder blasts" is usually
            what they meant, not "stop everything". Also the only escape hatch
            when the mail that annoyed them belongs to a different group than the
            one they happened to click from. */}
        {phase.state === 'ready' && (
          <section
            data-testid="unsubscribe-preferences"
            className="rounded-2xl bg-white dark:bg-gray-900 p-6 sm:p-8 shadow-sm"
          >
            <div data-testid="unsub-center">
              <CenterHeading className="text-base font-semibold text-gray-900 dark:text-gray-100">
                {t.unsubscribe.centerTitle}
              </CenterHeading>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t.unsubscribe.centerHint}</p>

              {masterOff && (
                <p
                  data-testid="unsub-master-off"
                  className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900"
                >
                  {t.unsubscribe.masterOffNote}
                </p>
              )}

              {saveFailed && (
                <p
                  data-testid="unsub-save-failed"
                  role="status"
                  className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-900"
                >
                  {t.unsubscribe.saveFailed}
                </p>
              )}

              <ul className="mt-5 space-y-4">
                {toggles.map((g) => (
                  <li key={g.id}>
                    {/* The description is a sibling of the <label>, never inside
                        it: a label's accessible name is its whole text content,
                        and a two-sentence name is unusable in a screen reader. */}
                    <label
                      data-testid={`unsubscribe-group-toggle-${g.id}`}
                      className="flex items-start gap-3 text-sm font-medium text-gray-800 dark:text-gray-100"
                    >
                      <input
                        type="checkbox"
                        data-testid={`unsub-group-toggle-${g.id}`}
                        className="mt-0.5 h-4 w-4 shrink-0 rounded border-gray-300 text-blue-600"
                        checked={g.enabled}
                        disabled={busyGroup !== null}
                        onChange={(e) => setGroupEnabled(g.id, e.target.checked)}
                      />
                      <span>{groupName(g.id)}</span>
                    </label>
                    <p className="mt-1 pl-7 text-xs text-gray-500 dark:text-gray-400">
                      {groupDesc(g.id)}
                      {busyGroup === g.id && (
                        <span className="ml-2 text-gray-400 dark:text-gray-500">{t.unsubscribe.saving}</span>
                      )}
                    </p>
                  </li>
                ))}
              </ul>

              {essentials.length > 0 && (
                <div className="mt-8 border-t border-gray-200 dark:border-gray-800 pt-5">
                  <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
                    <Lock className="h-4 w-4 text-gray-400" aria-hidden />
                    {t.unsubscribe.essentialHeading}
                  </h2>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {t.unsubscribe.essentialHint}
                  </p>
                  <ul className="mt-3 space-y-3">
                    {/* No <input> at all on these rows. A disabled checkbox next
                        to a password-reset notice reads as "we broke your
                        switch"; a plain "always sent" row says what is true. */}
                    {essentials.map((g) => (
                      <li
                        key={g.id}
                        data-testid={`unsub-group-essential-${g.id}`}
                        className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"
                      >
                        <span className="text-sm text-gray-700 dark:text-gray-200">{groupName(g.id)}</span>
                        <span className="text-xs text-gray-400 dark:text-gray-500">
                          {t.unsubscribe.alwaysSent}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="mt-8 border-t border-gray-200 dark:border-gray-800 pt-5">
                <Link
                  href="/account"
                  data-testid="unsub-open-settings"
                  className="text-sm font-medium text-blue-600 hover:text-blue-700 hover:underline"
                >
                  {t.unsubscribe.openSettings}
                </Link>
              </div>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
