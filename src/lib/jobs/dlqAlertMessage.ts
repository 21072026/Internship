import { sanitizeError } from '@/lib/sanitizeError';

// The dead-letter alert's *message* (#1674) — pure string building, no Prisma,
// no nodemailer, no node-cron.
//
// Split out of dlqAlert.ts on purpose, the same way lib/newsletter.ts is kept
// free of the send path: the interesting behaviour here is "what does the
// operator read, and when do we say nothing at all", and that is worth testing
// without standing up a database or a mail transport
// (e2e/job-queue-dlq-alert.unit.spec.ts imports this file and only this file).

// How many lines of each list the mail actually prints. The rest is summarised
// as a "+N more" tail — the point of the mail is "go look", not "read this".
export const MAX_ROWS_SHOWN = 10;

export interface DeadLetterGroup {
  name: string;
  count: number;
  /** When this job type last landed in the dead-letter queue. */
  lastFailedAt: string | null;
}

export interface DeadLetterReason {
  /** Sanitised, first line only, truncated — never a raw handler dump. */
  reason: string;
  count: number;
}

export interface DeadLetterSummary {
  total: number;
  /** When the oldest dead-lettered job was first enqueued. */
  oldestAt: string | null;
  byName: DeadLetterGroup[];
  reasons: DeadLetterReason[];
  /** How many rows the reason histogram was built from. */
  reasonsSampledFrom: number;
}

/**
 * One failure reason, reduced to something countable.
 *
 * `Job.lastError` is whatever the handler threw, so it may echo an address, a
 * token or a certificate — it goes through the shared sanitiser first, exactly
 * like every other error surface in this repo. Only the first line survives: a
 * stack trace differs on every row and would defeat the grouping this mail
 * exists to do.
 */
export function normalizeReason(raw: string | null | undefined): string {
  const clean = sanitizeError(raw)?.split('\n')[0]?.trim();
  return clean && clean.length > 0 ? clean.slice(0, 120) : 'bilinmeyen hata';
}

function esc(value: string): string {
  return value.replace(
    /[<>&"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] as string)
  );
}

export function trDate(iso: string | null): string {
  if (!iso) return 'bilinmiyor';
  // Fixed locale and zone: this mail has exactly one reader profile (the
  // operator) and a timestamp that shifts with the server's TZ setting is a
  // timestamp nobody can correlate with a log line.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'bilinmiyor';
  return (
    d.toLocaleString('tr-TR', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }) + ' UTC'
  );
}

function listWithTail(rows: string[], total: number, unit: string): string {
  const shown = rows.slice(0, MAX_ROWS_SHOWN);
  const rest = total - shown.length;
  if (rest > 0) shown.push(`<li>… ve ${rest} ${unit} daha</li>`);
  return shown.join('');
}

/**
 * The message for a summary, or `null` when there is nothing to report.
 *
 * Returning null rather than sending an "all clear" is the whole convention: a
 * daily green mail trains the reader to archive the alert unread, and then the
 * one that matters is archived too. Same discipline as the e2e and k6 reports.
 */
export function buildDeadLetterAlert(
  summary: DeadLetterSummary
): { subject: string; html: string } | null {
  if (summary.total <= 0) return null;

  const nameRows = summary.byName.map(
    (g) => `<li><code>${esc(g.name)}</code> — <b>${g.count}</b> iş, son düşen: ${esc(trDate(g.lastFailedAt))}</li>`
  );
  const reasonRows = summary.reasons.map((r) => `<li><b>${r.count}×</b> ${esc(r.reason)}</li>`);
  const sampleNote =
    summary.total > summary.reasonsSampledFrom
      ? ` (en son ${summary.reasonsSampledFrom} kayıt üzerinden)`
      : '';

  return {
    subject: `[CRM] Ölü mektup kuyruğunda ${summary.total} iş bekliyor`,
    html: `<div style="font-family: Arial, sans-serif; max-width: 680px; margin: 0 auto;">
      <h2 style="color:#b91c1c;">Ölü mektup kuyruğu boş değil</h2>
      <p>Tüm denemeleri tükenmiş <b>${summary.total}</b> iş var; en eskisi <b>${esc(trDate(summary.oldestAt))}</b> tarihinden beri bekliyor. Bu işler kendiliğinden tekrar çalışmaz — elle incelenmesi gerekir.</p>
      <h3 style="font-size:15px;">İş türüne göre</h3>
      <ul style="padding-left:18px;">${listWithTail(nameRows, summary.byName.length, 'tür')}</ul>
      <h3 style="font-size:15px;">Hata nedenleri${esc(sampleNote)}</h3>
      <ul style="padding-left:18px;">${listWithTail(reasonRows, summary.reasons.length, 'neden')}</ul>
      <p style="font-size:13px;color:#6b7280;">Canlı sayaçlar: <code>/api/health?jobs=1</code> (HEALTH_TOKEN başlığı veya ADMIN oturumu ile).</p>
      <p style="font-size:12px;color:#9ca3af;">Kuyruk boşaldığında bu e-posta gönderilmez; yani bir sonraki sessizlik "sorun çözüldü" demektir.</p>
    </div>`,
  };
}
