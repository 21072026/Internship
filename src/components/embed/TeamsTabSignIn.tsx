'use client';

import { useCallback, useEffect, useState } from 'react';
import { app, authentication } from '@microsoft/teams-js';
import { useT } from '@/i18n/client';

// The Teams tab's sign-in (#1954, docs/teams-tab-sso.md). Inside Teams: ask
// Teams for the Entra token, trade it at /sso for a grant (its nonce lands in
// this frame's partitioned cookie), redeem the grant at /session — asking for
// the authenticator code when the account has one — and go to the role home.
// Outside Teams, or for a member who has not linked their account, the "link
// your account" screen stays. Nothing here ever creates an account.

type State = 'working' | 'link' | 'totp' | 'refused';

const INIT_TIMEOUT_MS = 5_000;

async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(path, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
}

export function TeamsTabSignIn() {
  const copy = useT().embed;
  const [state, setState] = useState<State>('working');
  const [grant, setGrant] = useState<string | null>(null);
  const [code, setCode] = useState('');

  const redeem = useCallback(async (g: string, totp?: string) => {
    const res = await post('/api/integrations/chat/teams/session', { grant: g, ...(totp ? { totp } : {}) });
    if (res.status === 200) {
      window.location.replace('/embed/home');
      return;
    }
    if (res.json.code === '2FA_REQUIRED') {
      setGrant(g);
      setState('totp');
      return;
    }
    setState('refused');
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Outside Teams the SDK may never answer: give up after a few seconds.
        await Promise.race([app.initialize(), new Promise((_, reject) => setTimeout(() => reject(new Error('not_in_teams')), INIT_TIMEOUT_MS))]);
        const token = await authentication.getAuthToken();
        const res = await post('/api/integrations/chat/teams/sso', { token });
        if (cancelled) return;
        if (typeof res.json.grant === 'string') await redeem(res.json.grant);
        else setState(res.json.link ? 'link' : 'refused');
      } catch {
        // Not inside Teams, or Teams would not hand out a token.
        if (!cancelled) setState('link');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [redeem]);

  if (state === 'working') return <p data-testid="embed-working">{copy.working}</p>;
  if (state === 'totp') {
    return (
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (grant) void redeem(grant, code.trim());
        }}
      >
        <label className="block" htmlFor="embed-totp">{copy.totpLabel}</label>
        <input
          id="embed-totp"
          className="w-full rounded border border-gray-300 px-3 py-2 dark:border-gray-600 dark:bg-gray-800"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <button type="submit" className="rounded bg-blue-600 px-4 py-2 text-white">{copy.totpSubmit}</button>
      </form>
    );
  }
  return (
    <>
      <h1 className="mb-2 text-lg font-semibold">{state === 'refused' ? copy.refusedTitle : copy.linkTitle}</h1>
      <p className="mb-4" data-testid="embed-link">{state === 'refused' ? copy.refusedBody : copy.linkBody}</p>
      <a className="text-blue-600 underline" href="/account" target="_blank" rel="noopener noreferrer">{copy.linkCta}</a>
    </>
  );
}
