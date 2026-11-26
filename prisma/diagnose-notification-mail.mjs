// Report-only: where does a notification e-mail stop? (hand-off mail, 2026-11)
//
//   node prisma/diagnose-notification-mail.mjs            # last 14 days
//   node prisma/diagnose-notification-mail.mjs --days 30
//
// WHY THIS EXISTS
//   A hand-off rings the new owner's bell but, on production, the mail does
//   not arrive (#3871 sends it). The bell is written directly; the mail goes
//   the long way — notifyEvent(channels: ['email']) → a `notification.email`
//   job → the job worker → sendEmail() → the mail queue / SMTP — and every
//   stage records why it stopped. The data-access policy keeps contributors off
//   prod data, so this prints the answer as COUNTS, in the deploy log
//   (infra/deploy-prod.sh), the same way check-marketing-orgs.mjs does.
//
// WHAT IT PRINTS (no personal data: no address, name, subject or free text)
//   1. NotificationDelivery per event (lead.handedOff, and for comparison
//      mentorship.reassignedAway, which takes the same path) × channel ×
//      status × skipReason;
//   2. the `notification.email` jobs for those events by status, and how old the
//      oldest still-pending one is;
//   3. EmailLog rows of category `mentee-assigned` by status × reason — the
//      reason reduced to its first words (`Unsubscribed: <group>`,
//      `Suppressed: BOUNCE`, `SMTP …`), any address in it removed;
//   4. the mail queue: `email.send` jobs of that category by status × reason;
//   5. per hand-off mail the ledger calls SENT: the EmailLog rows to that
//      recipient within two hours, WHATEVER their category, by status ×
//      category × reason — matched on the address inside this script, which is
//      never printed — so a mail logged under another category, or not at all,
//      shows up;
//   6. the job worker's pulse: when it last finished any job, and how many jobs
//      have been due for more than 10 minutes.
//   Never writes, always exits 0.
import { PrismaClient } from '@prisma/client';

export const EVENTS = ['lead.handedOff', 'mentorship.reassignedAway'];
export const MAIL_CATEGORY = 'mentee-assigned';
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** A stored error reduced to a short, address-free reason. */
export function reasonOf(error) {
  if (!error) return '-';
  const head = String(error).replace(EMAIL, '[email]').split(/[\n(]/)[0];
  const words = head.split(/\s+/).filter(Boolean).slice(0, 4).join(' ');
  return words.slice(0, 48) || '-';
}

/** "SENT=2 SKIPPED[send_skipped]=3" from grouped rows, in a stable order. */
export function formatCounts(rows, key) {
  if (rows.length === 0) return 'none';
  return rows
    .map((r) => ({ label: key(r), n: r.n }))
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((r) => `${r.label}=${r.n}`)
    .join(' ');
}

/** Minutes between two dates, rounded; '—' without a date. */
export function minutesAgo(date, now) {
  return date ? `${Math.round((now.getTime() - new Date(date).getTime()) / 60000)}m` : '—';
}

/** The report lines from plain facts (unit-tested without a database). */
export function mailReport({ days, deliveries, jobs, oldestPending, emailLogs, queueJobs = [], matched = null, lastJobFinished, overdueJobs, now }) {
  const lines = [`notification mail (last ${days} days, report only):`];
  for (const event of EVENTS) {
    for (const channel of ['inApp', 'email']) {
      const rows = deliveries.filter((d) => d.eventKey === event && d.channel === channel);
      lines.push(`  delivery ${event} ${channel}: ${formatCounts(rows, (r) => (r.skipReason ? `${r.status}[${r.skipReason}]` : r.status))}`);
    }
    const jobRows = jobs.filter((j) => j.eventKey === event);
    const pending = oldestPending[event];
    lines.push(`  job notification.email ${event}: ${formatCounts(jobRows, (r) => r.status)}${pending ? ` oldestPending=${minutesAgo(pending, now)}` : ''}`);
  }
  lines.push(`  email log ${MAIL_CATEGORY}: ${formatCounts(emailLogs, (r) => (r.reason === '-' ? r.status : `${r.status}[${r.reason}]`))}`);
  lines.push(`  mail queue email.send ${MAIL_CATEGORY}: ${formatCounts(queueJobs, (r) => (r.reason === '-' ? r.status : `${r.status}[${r.reason}]`))}`);
  if (matched) {
    lines.push(
      `  hand-off mails SENT by the ledger: ${matched.mails}; email log rows to those recipients within 2h: ` +
        `${formatCounts(matched.rows, (r) => `${r.status}/${r.category}${r.reason === '-' ? '' : `[${r.reason}]`}`)}; with none: ${matched.withNone}`,
    );
  }
  lines.push(`  job worker: lastFinished=${minutesAgo(lastJobFinished, now)} ago, overdueOver10m=${overdueJobs}`);
  return lines;
}

async function main() {
  const i = process.argv.indexOf('--days');
  const days = Math.min(Math.max(Number(i > 0 ? process.argv[i + 1] : 14) || 14, 1), 90);
  const now = new Date();
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const prisma = new PrismaClient();
  try {
    const deliveryGroups = await prisma.notificationDelivery.groupBy({
      by: ['eventKey', 'channel', 'status', 'skipReason'],
      where: { eventKey: { in: EVENTS }, createdAt: { gte: since } },
      _count: { _all: true },
    });
    const jobRows = [];
    const oldestPending = {};
    for (const event of EVENTS) {
      const where = { name: 'notification.email', createdAt: { gte: since }, payload: { path: '$.eventKey', equals: event } };
      const groups = await prisma.job.groupBy({ by: ['status'], where, _count: { _all: true } });
      for (const g of groups) jobRows.push({ eventKey: event, status: g.status, n: g._count._all });
      const oldest = await prisma.job.findFirst({ where: { ...where, status: 'PENDING' }, orderBy: { runAt: 'asc' }, select: { runAt: true } });
      if (oldest) oldestPending[event] = oldest.runAt;
    }
    const logs = await prisma.emailLog.findMany({
      where: { category: MAIL_CATEGORY, createdAt: { gte: since } },
      select: { status: true, error: true },
    });
    const byReason = new Map();
    for (const l of logs) {
      const k = `${l.status}\u0000${reasonOf(l.error)}`;
      byReason.set(k, (byReason.get(k) ?? 0) + 1);
    }
    const emailLogs = [...byReason].map(([k, n]) => {
      const [status, reason] = k.split('\u0000');
      return { status, reason, n };
    });
    // The mail queue for that category: its payload names the category in the clear.
    const queueRows = await prisma.job.findMany({
      where: { name: 'email.send', createdAt: { gte: since }, payload: { path: '$.category', equals: MAIL_CATEGORY } },
      select: { status: true, lastError: true },
    });
    const qMap = new Map();
    for (const q of queueRows) {
      const k = `${q.status}\u0000${reasonOf(q.lastError)}`;
      qMap.set(k, (qMap.get(k) ?? 0) + 1);
    }
    const queueJobs = [...qMap].map(([k, n]) => {
      const [status, reason] = k.split('\u0000');
      return { status, reason, n };
    });

    // Per SENT hand-off mail: what the mail log says about that recipient, any category.
    const sentRows = await prisma.notificationDelivery.findMany({
      where: { eventKey: 'lead.handedOff', channel: 'email', status: 'SENT', createdAt: { gte: since } },
      select: { userId: true, createdAt: true },
    });
    const users = await prisma.user.findMany({ where: { id: { in: [...new Set(sentRows.map((r) => r.userId))] } }, select: { id: true, email: true } });
    const emailOf = new Map(users.map((u) => [u.id, u.email]));
    const mMap = new Map();
    let withNone = 0;
    for (const r of sentRows) {
      const to = emailOf.get(r.userId);
      const found = to
        ? await prisma.emailLog.findMany({
            where: { to, createdAt: { gte: r.createdAt, lte: new Date(r.createdAt.getTime() + 2 * 60 * 60 * 1000) } },
            select: { status: true, category: true, error: true },
          })
        : [];
      if (found.length === 0) withNone += 1;
      for (const f of found) {
        const k = `${f.status}\u0000${f.category ?? 'none'}\u0000${reasonOf(f.error)}`;
        mMap.set(k, (mMap.get(k) ?? 0) + 1);
      }
    }
    const matched = {
      mails: sentRows.length,
      withNone,
      rows: [...mMap].map(([k, n]) => {
        const [status, category, reason] = k.split('\u0000');
        return { status, category, reason, n };
      }),
    };

    const lastJob = await prisma.job.findFirst({ where: { status: 'SUCCEEDED' }, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } });
    const overdueJobs = await prisma.job.count({ where: { status: 'PENDING', runAt: { lt: new Date(now.getTime() - 10 * 60 * 1000) } } });

    const lines = mailReport({
      days,
      deliveries: deliveryGroups.map((g) => ({ eventKey: g.eventKey, channel: g.channel, status: g.status, skipReason: g.skipReason, n: g._count._all })),
      jobs: jobRows,
      oldestPending,
      emailLogs,
      queueJobs,
      matched,
      lastJobFinished: lastJob?.updatedAt ?? null,
      overdueJobs,
      now,
    });
    for (const line of lines) console.log(line);
  } catch (e) {
    console.log(`notification mail report skipped: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
