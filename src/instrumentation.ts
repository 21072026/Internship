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
  startMailDrain();
  startJobWorker();
}

const BOOT_DELAY_MS = 5000;

function localUrl(path: string): string {
  return `http://127.0.0.1:${process.env.PORT || 3000}${path}`;
}

// The queue scheduler (src/lib/jobs/schedules.ts → /api/cron/start, #1676/#1677):
// every scheduled reminder, digest and sweep in the product. Gated on CRON_SECRET so only the environment
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

// Drains the outbound mail queue (#2944, src/lib/mailOutbox.ts): every 5 s,
// on EVERY replica, POST /api/mail/drain. No lease anywhere — the route claims
// rows with SKIP LOCKED, so replicas share the work instead of electing an
// owner, and the shared send budget sets the pace. MAIL_WORKER_ENABLED=0 is the
// kill switch (the deploy canary sets it: it shares production's database).
//
// The credential is CRON_SECRET where it exists. An environment without one
// (a topic environment) still needs its queued mail delivered, so a random
// MAIL_DRAIN_SECRET is minted here, in this process, and the route — same
// process — accepts it; it never leaves the process.
//
// `running` keeps a slow tick (a drain may take up to ~25 s) from overlapping
// the next one; the route's own claim makes an overlap harmless anyway, the
// guard only saves the round trip.
const MAIL_DRAIN_TICK_MS = 5000;

function startMailDrain() {
  const flag = (process.env.MAIL_WORKER_ENABLED || '').trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(flag)) return;
  // No SMTP here (the demo, the e2e server): sendEmail() skips every mail, so
  // nothing is ever queued and a tick would only knock on an empty door.
  if (!process.env.SMTP_USER) return;

  if (!process.env.CRON_SECRET && !process.env.MAIL_DRAIN_SECRET) {
    process.env.MAIL_DRAIN_SECRET = globalThis.crypto.randomUUID();
  }
  const secret = process.env.CRON_SECRET || process.env.MAIL_DRAIN_SECRET || '';

  let running = false;
  let lastError = 0;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const res = await fetch(localUrl('/api/mail/drain'), {
        method: 'POST',
        headers: { 'x-cron-secret': secret },
      });
      if (!res.ok && Date.now() - lastError > 60_000) {
        lastError = Date.now();
        console.error('[MailDrain] drain returned', res.status);
      }
    } catch (e) {
      // The server may still be coming up on the first ticks — not fatal, and
      // logged at most once a minute so a dead listener cannot flood the log.
      if (Date.now() - lastError > 60_000) {
        lastError = Date.now();
        console.error('[MailDrain] drain failed:', String(e));
      }
    } finally {
      running = false;
    }
  }, MAIL_DRAIN_TICK_MS);
  timer.unref?.();
}

// Runs the job worker (#1673, src/lib/jobs/worker.ts): every 5 s, on EVERY
// replica, POST /api/jobs/worker/tick. Same shape as the mail drain above and
// for the same reasons — no lease (SKIP LOCKED shares the work), a secret
// minted in-process where CRON_SECRET is absent, JOBS_WORKER_ENABLED=0 as the
// kill switch (the deploy canary sets it).
//
// No `running` guard here, on purpose: a tick's request stays open until the
// jobs it claimed have settled, and the route claims only into the capacity
// the in-flight ones leave free, so a long job must not stop the next tick
// from using the rest. `outstanding` only caps how many ticks a wedged server
// can pile up. A job longer than the HTTP client's ~5 min header timeout makes
// this fetch fail while the job carries on server-side — logged at most once a
// minute, harmless.
const JOB_WORKER_TICK_MS = 5000;
const JOB_WORKER_MAX_OUTSTANDING = 8;

function startJobWorker() {
  const flag = (process.env.JOBS_WORKER_ENABLED || '').trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(flag)) return;

  if (!process.env.CRON_SECRET && !process.env.JOBS_WORKER_SECRET) {
    process.env.JOBS_WORKER_SECRET = globalThis.crypto.randomUUID();
  }
  const secret = process.env.CRON_SECRET || process.env.JOBS_WORKER_SECRET || '';

  let outstanding = 0;
  let lastError = 0;
  const timer = setInterval(async () => {
    if (outstanding >= JOB_WORKER_MAX_OUTSTANDING) return;
    outstanding++;
    try {
      const res = await fetch(localUrl('/api/jobs/worker/tick'), {
        method: 'POST',
        headers: { 'x-cron-secret': secret },
      });
      if (!res.ok && Date.now() - lastError > 60_000) {
        lastError = Date.now();
        console.error('[JobWorker] tick returned', res.status);
      }
    } catch (e) {
      if (Date.now() - lastError > 60_000) {
        lastError = Date.now();
        console.error('[JobWorker] tick failed:', String(e));
      }
    } finally {
      outstanding--;
    }
  }, JOB_WORKER_TICK_MS);
  timer.unref?.();
}

// Drains the reply mailbox over IMAP. Started wherever the IMAP credentials are
// configured; INBOUND_IMAP_ENABLED=0 is the kill switch.
//
// Two pollers on one mailbox race over the \Seen flag, so the bridge must have
// exactly one owner. That used to rest on "the credentials only exist in
// production, and production is one container" — a coincidence, not a guarantee,
// and #1701 ends it by running two identically configured replicas. The owner is
// now decided by the `'imap-bridge'` JobLease, taken inside
// /api/inbound-email/poll (src/lib/jobs/lease.ts): every replica keeps ticking,
// and the ones that do not hold the lease get a quiet 200 and open no IMAP
// connection. The gate lives in the route rather than here because this file
// must stay dependency-free — see the header.
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
