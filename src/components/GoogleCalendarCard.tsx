'use client';

import { useEffect, useState } from 'react';
import { CalendarCheck, Link2, Unlink, Loader2, AlertTriangle } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { useT } from '@/i18n/client';

interface State {
  configured: boolean;
  enabled: boolean;
  connected: boolean;
  connection: { googleEmail: string; lastSyncAt: string | null; lastError: string | null } | null;
}

/**
 * "Connect my Google Calendar" (#709).
 *
 * The card is only shown when the operator has switched the integration on:
 * offering a button that cannot work — because no credentials exist on this
 * deployment — is worse than not offering it. Connecting is always the person's
 * own act, and disconnecting revokes at Google rather than only forgetting here.
 */
export function GoogleCalendarCard() {
  const t = useT();
  const g = t.googleCalendar;
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  // The STATUS KEY, not the translated sentence. Keeping the key here is what
  // lets this effect run exactly once: the dictionary object `useT()` returns is
  // a fresh reference on every render, so depending on it would re-fire the
  // effect on every render — each `setState` scheduling the next one. On a page
  // that also holds forms, that re-render loop resets fields under the user's
  // hands (it broke the account password spec before this was pinned down).
  const [flashKey, setFlashKey] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/integrations/google/connection')
      .then((r) => (r.ok ? r.json() : null))
      .then(setState)
      .catch(() => {});
    // The connect/callback flow is a redirect, so its outcome comes back in the
    // query string rather than in a fetch response.
    const status = new URLSearchParams(window.location.search).get('google');
    if (status) {
      setFlashKey(status);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const flash = flashKey
    ? (({ connected: g.flashConnected, disconnected: g.flashDisconnected, cancelled: g.flashCancelled, failed: g.flashFailed, unavailable: g.flashUnavailable } as Record<string, string>)[flashKey] ?? null)
    : null;

  if (!state || !state.enabled) return null;

  const disconnect = async () => {
    setBusy(true);
    try {
      await fetch('/api/integrations/google/connection', { method: 'DELETE' });
      setState({ ...state, connected: false, connection: null });
      setFlashKey('disconnected');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mt-6 max-w-4xl" data-testid="google-calendar-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarCheck className="h-5 w-5 text-blue-600" />
          {g.section}
        </CardTitle>
      </CardHeader>
      <div>
        <p className="text-sm text-gray-600 dark:text-gray-300">{g.description}</p>

        {flash && (
          <p data-testid="google-calendar-flash" className="mt-3 rounded-lg bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 px-3 py-2 text-sm text-blue-800 dark:text-blue-200">
            {flash}
          </p>
        )}

        {state.connected && state.connection ? (
          <div className="mt-4">
            <p data-testid="google-calendar-connected" className="text-sm text-gray-800 dark:text-gray-100">
              {g.connectedAs}: <span className="font-medium">{state.connection.googleEmail}</span>
            </p>
            {state.connection.lastError && (
              <p className="mt-2 inline-flex items-start gap-1.5 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                {g.lastErrorHint}
              </p>
            )}
            <button
              type="button"
              onClick={disconnect}
              disabled={busy}
              data-testid="google-calendar-disconnect"
              className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unlink className="h-4 w-4" />}
              {g.disconnect}
            </button>
          </div>
        ) : (
          <a
            href="/api/integrations/google/connect"
            data-testid="google-calendar-connect"
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            <Link2 className="h-4 w-4" />
            {g.connect}
          </a>
        )}
      </div>
    </Card>
  );
}
