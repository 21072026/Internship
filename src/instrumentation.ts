// Next.js server-boot hook. Runs once per server process — the only reliable
// place to start long-lived background work in the App Router (a route handler
// or layout would start it per request).
//
// It ticks the mail bridge by calling the app's own `/api/inbound-email/poll`
// rather than importing it. That indirection is deliberate: this project has
// `src/middleware.ts`, so Next also compiles instrumentation for the **edge**
// runtime, where imapflow's `net`/`tls`/`stream` imports cannot resolve and the
// build fails — even behind a `NEXT_RUNTIME` guard, because webpack still traces
// the import. Reaching the IMAP code over HTTP keeps this file dependency-free
// (`fetch` only) and leaves the node-only work in the node-only route handler.
//
// Deliberately narrow: it starts the mail bridge and nothing else. The node-cron
// jobs in `src/services/emailService.ts` (`initCronJobs`) are NOT wired up here —
// nothing calls them today, and switching them on would start sending reminder
// and digest email as a side effect of this change.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Same gate as bridgeConfig(): no credentials (dev, CI, preview, topic envs)
  // means no polling at all.
  const configured = process.env.INBOUND_IMAP_HOST && process.env.INBOUND_IMAP_USER && process.env.INBOUND_IMAP_PASS;
  if (!configured || process.env.INBOUND_IMAP_ENABLED === '0') return;

  const secret = process.env.INBOUND_SECRET;
  if (!secret) {
    console.error('[MailBridge] INBOUND_IMAP_* is set but INBOUND_SECRET is not — bridge not started.');
    return;
  }

  const seconds = Math.max(30, Number(process.env.INBOUND_IMAP_POLL_SECONDS || 60));
  const url = `http://127.0.0.1:${process.env.PORT || 3000}/api/inbound-email/poll`;

  let running = false;
  const timer = setInterval(async () => {
    if (running) return; // a slow tick must not overlap the next one
    running = true;
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'x-inbound-secret': secret } });
      if (!res.ok) console.error('[MailBridge] poll returned', res.status);
    } catch (e) {
      // The server may still be coming up on the first tick — not fatal.
      console.error('[MailBridge] poll failed:', String(e));
    } finally {
      running = false;
    }
  }, seconds * 1000);
  timer.unref?.(); // never hold the process open on this timer alone

  console.log(`[MailBridge] started — polling every ${seconds}s`);
}
