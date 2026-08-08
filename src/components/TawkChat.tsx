'use client';

import { useEffect } from 'react';
import { COOKIE_CONSENT_EVENT, hasConsent } from '@/lib/cookieConsent';

// tawk.to live chat on the landing page (#1174). Two things make this more than
// a copy-pasted <script> tag:
//   1. It is a third-party processor that sets its own cookies and sees the
//      visitor's IP, so it stays behind the marketing consent gate — the banner
//      was built for exactly this (lib/cookieConsent). Nothing is requested
//      before the visitor opts in.
//   2. The embed attaches itself to `document`, not to the React tree, so it
//      outlives this component on a client-side navigation off the landing
//      page. Hence the explicit hide on unmount.
// The widget id is public by design (it ships in the page HTML), so it lives
// here rather than in an env var.
const TAWK_SRC = 'https://embed.tawk.to/6a779020e014d81d4ab62b5c/1jvhglvou';
const SCRIPT_ID = 'tawk-to-embed';

interface TawkApi {
  showWidget?: () => void;
  hideWidget?: () => void;
  onLoad?: () => void;
}

declare global {
  // eslint-disable-next-line no-var
  var Tawk_API: TawkApi | undefined;
  // eslint-disable-next-line no-var
  var Tawk_LoadStart: Date | undefined;
}

// Whether the landing page is currently mounted. Module scope on purpose: the
// embed is a singleton on `document`, so "should it be visible" cannot live in
// component state — the script may finish loading after we already navigated away.
let wanted = false;

function inject() {
  if (document.getElementById(SCRIPT_ID)) return;
  const api: TawkApi = window.Tawk_API || {};
  // Runs once the widget is ready. If the visitor left the landing page while
  // the script was still loading, the bubble would otherwise pop up on the page
  // they moved to.
  api.onLoad = () => {
    if (!wanted) window.Tawk_API?.hideWidget?.();
  };
  window.Tawk_API = api;
  window.Tawk_LoadStart = new Date();

  const s = document.createElement('script');
  s.id = SCRIPT_ID;
  s.async = true;
  s.src = TAWK_SRC;
  s.charset = 'UTF-8';
  s.setAttribute('crossorigin', '*');
  document.head.appendChild(s);
}

export function TawkChat() {
  useEffect(() => {
    wanted = true;

    const load = () => {
      if (!hasConsent('marketing')) return;
      inject();
      // Already loaded from an earlier visit to this page in the same session.
      window.Tawk_API?.showWidget?.();
    };

    load();
    // Accepting in the banner should bring the widget up right away rather than
    // on the next full page load.
    window.addEventListener(COOKIE_CONSENT_EVENT, load);

    return () => {
      wanted = false;
      window.removeEventListener(COOKIE_CONSENT_EVENT, load);
      window.Tawk_API?.hideWidget?.();
    };
  }, []);

  return null;
}
