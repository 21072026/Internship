// Next.js server-boot hook. Runs once per server process — the only reliable
// place to start long-lived background work in the App Router (a route handler
// or layout would start it per request).
//
// Both jobs below are kicked off by calling one of the app's own endpoints
// rather than by importing the code that does the work. That indirection is
// deliberate: this project has `src/middleware.ts`, so Next also compiles
// instrumentation for the **edge** runtime, where imapflow's `net`/`tls`/`stream`
// (and Prisma, and nodemailer) cannot resolve and the build fails — even behind a
// `NEXT_RUNTIME` guard, because webpack still traces the import graph. Keeping
// this file dependency-free (`fetch` only) leaves the node-only work in
// node-only route handlers.
//
// Nothing here is awaited to completion: `register()` resolves before the server
// starts accepting connections, so awaiting a request to ourselves would
// deadlock. Both starts are deferred onto timers instead.
export function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  startMailBridge();
  startCron();
}

const BOOT_DELAY_MS = 5000;

function localUrl(path: string): string {
  return `http://127.0.0.1:${process.env.PORT || 3000}${path}`;
}

// The scheduled reminder/digest jobs (`initCronJobs` in
// `src/services/emailService.ts`). Gated on CRON_SECRET so only the environment
// that should mail real people does: the preview DB is shared with every topic
// env and holds the same addresses, so a scheduler running there would email
// real users. CRON_ENABLED=0 is the kill switch.
function startCron() {
  const secret = process.env.CRON_SECRET;
  if (!secret || process.env.CRON_ENABLED === '0') return;

  // Registering the schedules is a one-shot call, but the server may not be
  // listening yet — retry a few times with backoff before giving up.
  let attempt = 0;
  const tryStart = async () => {
    attempt++;
    try {
      const res = await fetch(localUrl('/api/cron/start'), {
        method: 'POST',
        headers: { 'x-cron-secret': secret },
      });
      if (res.ok) {
        console.log('[Cron] schedules registered');
        return;
      }
      // A real answer (bad secret / not configured) — retrying repeats it.
      console.error('[Cron] start returned', res.status);
    } catch {
      if (attempt < 5) {
        setTimeout(tryStart, BOOT_DELAY_MS * attempt).unref?.();
        return;
      }
      console.error('[Cron] could not reach /api/cron/start; schedules NOT registered');
    }
  };
  setTimeout(tryStart, BOOT_DELAY_MS).unref?.();
}

// Drains the reply mailbox over IMAP. Gated on the IMAP credentials, which live
// only in production — two containers polling one mailbox would race over the
// \Seen flag.
function startMailBridge() {
  const configured = process.env.INBOUND_IMAP_HOST && process.env.INBOUND_IMAP_USER && process.env.INBOUND_IMAP_PASS;
  if (!configured || process.env.INBOUND_IMAP_ENABLED === '0') return;

  const secret = process.env.INBOUND_SECRET;
  if (!secret) {
    console.error('[MailBridge] INBOUND_IMAP_* is set but INBOUND_SECRET is not — bridge not started.');
    return;
  }

  const seconds = Math.max(30, Number(process.env.INBOUND_IMAP_POLL_SECONDS || 60));

  let running = false;
  const timer = setInterval(async () => {
    if (running) return; // a slow tick must not overlap the next one
    running = true;
    try {
      const res = await fetch(localUrl('/api/inbound-email/poll'), {
        method: 'POST',
        headers: { 'x-inbound-secret': secret },
      });
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
