'use client';

import { useEffect, useRef, useState } from 'react';
import { parseJaasMeetingLink } from '@/lib/meetingLink';

// The embedded call, on our own JaaS tenant (#1237).
//
// A plain `<iframe src>` was enough against the public Jitsi, but that instance
// hangs up on embedded calls after five minutes. JaaS wants a signed JWT, and the
// supported way to hand one over is 8x8's `external_api.js`, which builds the
// iframe itself — hence a script tag and an imperative API instead of markup.
//
// The token is fetched per mount from GET /api/meetings/[id]/call-token and lives
// only in this component. Anything that goes wrong — no tenant configured, an old
// meet.jit.si link, a blocked script — renders `fallback` instead, which is how
// the panel keeps offering "open in a new tab" rather than showing a black box.

interface JitsiError {
  error?: { name?: string; message?: string; isFatal?: boolean };
}

interface ExternalApi {
  dispose(): void;
  addListener(event: string, listener: (payload?: JitsiError) => void): void;
}

declare global {
  interface Window {
    JitsiMeetExternalAPI?: new (domain: string, options: Record<string, unknown>) => ExternalApi;
  }
}

// One promise per tenant script: the panel can be reopened many times in a
// session, and each remount must not append another copy of the same script.
const scriptLoads = new Map<string, Promise<void>>();

function loadExternalApi(appId: string): Promise<void> {
  const src = `https://8x8.vc/${appId}/external_api.js`;
  const cached = scriptLoads.get(src);
  if (cached) return cached;

  const load = new Promise<void>((resolve, reject) => {
    if (window.JitsiMeetExternalAPI) {
      resolve();
      return;
    }
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => {
      // Drop the failed attempt so reopening the panel retries rather than
      // remembering a rejection forever (a flaky network, an offline moment).
      scriptLoads.delete(src);
      reject(new Error('Could not load the JaaS external API'));
    };
    document.head.appendChild(el);
  });

  scriptLoads.set(src, load);
  return load;
}

interface CallTokenResponse {
  domain: string;
  appId: string;
  roomName: string;
  jwt: string;
}

export function JaasCall({
  meetingId,
  meetLink,
  title,
  className,
  fallback,
  onReadyToClose,
}: {
  meetingId: string;
  meetLink: string;
  title: string;
  className?: string;
  fallback: React.ReactNode;
  /** Fired when the participant leaves from inside the call ("hang up"). */
  onReadyToClose?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  // Kept in a ref so the effect below doesn't have to re-run (and tear the call
  // down) just because the parent re-rendered with a new closure.
  const closeRef = useRef(onReadyToClose);
  closeRef.current = onReadyToClose;

  useEffect(() => {
    if (!parseJaasMeetingLink(meetLink)) {
      setFailed(true);
      return;
    }

    let cancelled = false;
    let api: ExternalApi | null = null;

    (async () => {
      try {
        const res = await fetch(`/api/meetings/${meetingId}/call-token`);
        if (!res.ok) throw new Error(`call-token: ${res.status}`);
        const data: CallTokenResponse = await res.json();
        await loadExternalApi(data.appId);
        // The panel may well have been closed while the script was loading.
        if (cancelled) return;
        const Api = window.JitsiMeetExternalAPI;
        if (!Api || !containerRef.current) throw new Error('external API unavailable');

        api = new Api(data.domain, {
          roomName: data.roomName,
          jwt: data.jwt,
          parentNode: containerRef.current,
          // The prejoin screen stays on purpose: it is where someone confirms
          // which camera and microphone they are about to open, and skipping it
          // would put a live mic in a panel that opens on a click elsewhere.
          configOverwrite: { prejoinPageEnabled: true },
        });
        api.addListener('readyToClose', () => closeRef.current?.());
        // A rejected token or a dead tenant leaves the iframe blank — 8x8 reports
        // it here, and a blank panel is worse than the plain link. Only fatal
        // errors: the recoverable ones (a reconnect, a failed device) are the
        // call's own business and it recovers on its own.
        api.addListener('errorOccurred', (payload) => {
          if (!payload?.error?.isFatal) return;
          // Tear the dead call down here rather than waiting for the unmount:
          // rendering the fallback removes the container, and an orphaned iframe
          // could hold the microphone until the panel is closed.
          try {
            api?.dispose();
          } catch {
            /* already gone */
          }
          api = null;
          setFailed(true);
        });
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      // Leaves the room and removes the iframe — without this, closing the panel
      // would keep the microphone open.
      try {
        api?.dispose();
      } catch {
        /* already gone */
      }
    };
  }, [meetingId, meetLink]);

  if (failed) return <>{fallback}</>;

  return <div ref={containerRef} aria-label={title} className={className} />;
}
