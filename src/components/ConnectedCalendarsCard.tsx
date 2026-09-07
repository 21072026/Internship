'use client';

import { useEffect, useState } from 'react';
import { CalendarCheck, Link2, Unlink, Loader2, AlertTriangle, RefreshCw } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { useT, useLocale } from '@/i18n/client';
import { relativeTime } from '@/lib/relativeTime';

interface ProviderRow {
  provider: string;
  label: string;
  configured: boolean;
  enabled: boolean;
  connected: boolean;
  accountEmail: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  connectPath: string;
  disconnectPath: string;
}

/**
 * "Connected calendars" (#1993) — one card for every calendar provider,
 * replacing the Google-only card from #709.
 *
 * It is driven entirely by GET /api/integrations/calendar/status, so a new
 * provider (#1991) appears here by being added to the server-side registry;
 * nothing in this file names Google.
 *
 * Four states per row, and they are four on purpose:
 *   (a) the operator has not set the provider up — say so. A connect button
 *       that can only bounce back with "unavailable" is worse than no button.
 *   (b) set up, but switched off for everyone on this installation. Different
 *       sentence from (a): "not set up" and "turned off" are different facts,
 *       and only one of them is likely to change back.
 *   (c) available, but this person has not connected — offer connect.
 *   (d) connected — show WHICH account (so they can tell what they are about to
 *       disconnect), when it last synced, and a warning strip whenever meetings
 *       are NOT reaching that calendar: either because the stored `lastError`
 *       says the last write failed, or because the provider is switched off
 *       here, which stops `pushMeeting()` at its first line and would otherwise
 *       leave the row reading "connected, last synced 3 hours ago" forever. A
 *       connection nothing is flowing through must never look healthy — that
 *       silent lie is the whole reason this card exists.
 */
export function ConnectedCalendarsCard() {
  const t = useT();
  const c = t.connectedCalendars;
  const locale = useLocale();
  const [rows, setRows] = useState<ProviderRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // The STATUS KEY, not the translated sentence. Keeping the key here is what
  // lets this effect run exactly once: the dictionary object `useT()` returns is
  // a fresh reference on every render, so depending on it would re-fire the
  // effect on every render — each `setState` scheduling the next one. On a page
  // that also holds forms, that re-render loop resets fields under the user's
  // hands (it broke the account password spec before this was pinned down).
  const [flashKey, setFlashKey] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/integrations/calendar/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setRows(d?.providers ?? []))
      .catch(() => setRows([]));
    // The connect/callback flow is a redirect, so its outcome comes back in the
    // query string rather than in a fetch response.
    const status = new URLSearchParams(window.location.search).get('google');
    if (status) {
      setFlashKey(status);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const g = t.googleCalendar;
  const flash = flashKey
    ? (({
        connected: g.flashConnected,
        disconnected: g.flashDisconnected,
        cancelled: g.flashCancelled,
        failed: g.flashFailed,
        unavailable: g.flashUnavailable,
        disconnectFailed: c.disconnectFailed,
      } as Record<string, string>)[flashKey] ?? null)
    : null;

  if (!rows || rows.length === 0) return null;

  const disconnect = async (row: ProviderRow) => {
    setBusy(row.provider);
    try {
      // The DELETE can be refused — an unverified account is held to reads by
      // `middleware.ts`, and a 500 or an offline tab look the same from here.
      // Rewriting the row before checking would show "disconnected and access
      // revoked" while the tokens are still stored and meetings still flowing:
      // the same untrue claim, told the other way round.
      const res = await fetch(row.disconnectPath, { method: 'DELETE' });
      if (!res.ok) {
        setFlashKey('disconnectFailed');
        return;
      }
      // Re-read rather than patch: what the card claims should come from the
      // server that did the work, not from this function's assumption of it.
      const refreshed = await fetch('/api/integrations/calendar/status')
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (refreshed?.providers) setRows(refreshed.providers);
      else
        setRows((prev) =>
          (prev ?? []).map((r) =>
            r.provider === row.provider
              ? { ...r, connected: false, accountEmail: null, lastSyncAt: null, lastError: null }
              : r
          )
        );
      setFlashKey('disconnected');
    } catch {
      setFlashKey('disconnectFailed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="mt-6 max-w-4xl" data-testid="connected-calendars-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarCheck className="h-5 w-5 text-blue-600" />
          {c.section}
        </CardTitle>
      </CardHeader>
      <div>
        <p className="text-sm text-gray-600 dark:text-gray-300">{c.description}</p>

        {flash && (
          <p
            data-testid="connected-calendars-flash"
            className="mt-3 rounded-lg bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 px-3 py-2 text-sm text-blue-800 dark:text-blue-200"
          >
            {flash}
          </p>
        )}

        <ul className="mt-4 divide-y divide-gray-200 dark:divide-gray-800">
          {rows.map((row) => {
            // "Available" is configured AND switched on: only then can this
            // deployment actually move a meeting into that calendar. The two
            // ways of not being available are told apart, because they are not
            // the same news.
            const available = row.configured && row.enabled;
            const switchedOff = row.configured && !row.enabled;
            return (
              <li key={row.provider} data-testid={`calendar-provider-${row.provider}`} className="py-4 first:pt-0 last:pb-0">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{row.label}</p>

                {!available && !row.connected && (
                  <p
                    data-testid={`${row.provider}-calendar-unavailable`}
                    className="mt-1 text-sm text-gray-500 dark:text-gray-400"
                  >
                    {switchedOff ? c.notEnabled : c.notConfigured}
                  </p>
                )}

                {available && !row.connected && (
                  <a
                    href={row.connectPath}
                    data-testid={`${row.provider}-calendar-connect`}
                    className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                  >
                    <Link2 className="h-4 w-4" />
                    {c.connect}
                  </a>
                )}

                {row.connected && (
                  <div className="mt-1">
                    <p
                      data-testid={`${row.provider}-calendar-connected`}
                      className="text-sm text-gray-800 dark:text-gray-100"
                    >
                      {c.connectedAs}: <span className="font-medium">{row.accountEmail}</span>
                    </p>
                    <p
                      data-testid={`${row.provider}-calendar-last-sync`}
                      className="mt-0.5 text-xs text-gray-500 dark:text-gray-400"
                    >
                      {row.lastSyncAt
                        ? c.lastSynced.replace('{when}', relativeTime(row.lastSyncAt, locale))
                        : c.neverSynced}
                    </p>

                    {/* One strip, two reasons for it. Both mean the same
                        thing to the person reading: meetings are not reaching
                        this calendar right now. */}
                    {!available ? (
                      <div
                        data-testid={`${row.provider}-calendar-off`}
                        className="mt-3 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
                      >
                        <p className="flex items-start gap-1.5 font-medium">
                          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                          {c.offTitle}
                        </p>
                        {/* No Reconnect here: the connect route checks the same
                            switch and can only bounce back with "unavailable".
                            Disconnect stays — revoking must always be possible. */}
                        <p className="mt-1">{c.offHint.replace('{provider}', row.label)}</p>
                      </div>
                    ) : row.lastError ? (
                      <div
                        data-testid={`${row.provider}-calendar-error`}
                        className="mt-3 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
                      >
                        <p className="flex items-start gap-1.5 font-medium">
                          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                          {c.errorTitle}
                        </p>
                        <p className="mt-1">{c.errorHint}</p>
                        {/* The provider's own words, kept: "invalid_grant" is
                            the difference between "reconnect" and "call
                            support". Sanitized server-side. */}
                        <p className="mt-1 break-words font-mono text-[11px] opacity-80">{row.lastError}</p>
                        <a
                          href={row.connectPath}
                          data-testid={`${row.provider}-calendar-reconnect`}
                          className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-amber-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-800 dark:!text-white"
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                          {c.reconnect}
                        </a>
                      </div>
                    ) : null}

                    <button
                      type="button"
                      onClick={() => disconnect(row)}
                      disabled={busy === row.provider}
                      data-testid={`${row.provider}-calendar-disconnect`}
                      className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40"
                    >
                      {busy === row.provider ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unlink className="h-4 w-4" />}
                      {c.disconnect}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </Card>
  );
}
