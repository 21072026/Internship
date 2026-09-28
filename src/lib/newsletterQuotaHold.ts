// A newsletter issue the broadcast quota is holding (#2335): which due issues
// one dispatch tick attempts, and what the operator is told about the one that
// is waiting. Pure and dependency-free — no Prisma, no nodemailer, no node-cron —
// so the rule is unit-tested on its own (scripts/test/newsletter-quota-hold.test.mjs).
//
// ── WHY THE TICK NEEDS A RULE ──────────────────────────────────────────────
// An issue the quota refuses stays SCHEDULED on purpose: a refusal must leave it
// editable, cancellable and re-sendable once the band allows (docs/newsletter.md
// § The broadcast quota). So it is due again on the next tick, and on the one
// after that. The tick used to attempt the ten oldest due issues, whatever the
// outcome — so ten issues from ONE tenant whose month is spent filled every tick,
// and no other tenant's issue was reached until that tenant's meter reset. The
// band of one organization then decided whether every other organization got its
// newsletter, which is the one thing a per-organization band must not do.
//
// ── THE RULE ───────────────────────────────────────────────────────────────
//   1. A HELD attempt does not spend the tick's budget. The budget bounds how
//      much mail one tick can push at the bulk channel, and a held issue pushed
//      none: it was refused before its audience was touched.
//   2. Once a tenant has a held issue in a tick, that tenant's later issues are
//      not attempted in the same tick. They wait, in order, behind the one that
//      is waiting. A later, smaller issue slipping past an older one the admin
//      queued first would reorder the tenant's own schedule behind its back —
//      and it bounds the cost of one tenant's backlog to ONE quota check per
//      tick, however many issues it has queued.
//   3. Order is otherwise the caller's (oldest `scheduledAt` first). The rule
//      never reorders; it only skips.

/** How many attempts that could mail someone one tick makes at most. */
export const NEWSLETTER_TICK_BUDGET = 10;

export interface DueNewsletterRef {
  id: string;
  /** The issue's tenant. `null` (a legacy row) is its own bucket. */
  orgId: string | null;
}

export interface NewsletterTickRun<R> {
  /** Every attempt's result, held ones included, in the order attempted. */
  results: R[];
  /** Issues left for the next tick because their tenant's older issue is held. */
  waiting: string[];
  /** The tenants that had an issue held this tick (`''` = no tenant). */
  heldOrgs: string[];
}

/**
 * One dispatch tick over `due`, which must already be in send order.
 *
 * `attempt` resolves to `null` when the dispatch threw (the caller logs it).
 * A throw still spends budget: it may have got part-way through its audience,
 * and the budget exists to bound mail, not successes.
 */
export async function runNewsletterTick<T extends DueNewsletterRef, R>(
  due: readonly T[],
  attempt: (issue: T) => Promise<R | null>,
  options: { isHeld: (result: R) => boolean; budget?: number },
): Promise<NewsletterTickRun<R>> {
  const budget = options.budget ?? NEWSLETTER_TICK_BUDGET;
  const held = new Set<string>();
  const results: R[] = [];
  const waiting: string[] = [];
  let spent = 0;

  for (const issue of due) {
    if (spent >= budget) break;
    const tenant = issue.orgId ?? '';
    if (held.has(tenant)) {
      waiting.push(issue.id);
      continue;
    }
    const result = await attempt(issue);
    if (result !== null && options.isHeld(result)) {
      held.add(tenant);
      results.push(result);
      continue;
    }
    spent++;
    if (result !== null) results.push(result);
  }

  return { results, waiting, heldOrgs: [...held] };
}

// ── The operator alert ─────────────────────────────────────────────────────
// A held issue that nobody pressed Send on (the cadence's own, or one an admin
// scheduled for a date) used to produce a warning line in the server log every
// fifteen minutes and nothing else. The alert makes it loud ONCE: the dispatcher
// writes one ActivityLog row per held issue per broadcast month and mails this
// to ALERT_EMAIL_TO. It is Turkish for the same reason the dead-letter alert is
// (src/lib/jobs/dlqAlertMessage.ts): it has exactly one reader, the operator.

export interface NewsletterQuotaHoldFacts {
  newsletterId: string;
  subject: string;
  /** The tenant whose band is holding it — named, because that is what the operator acts on. */
  orgName: string | null;
  orgSlug: string | null;
  used: number;
  limit: number | null;
  requested: number;
  remaining: number | null;
  /** ISO timestamp: when the month's meter goes back to zero. */
  resetsAt: string;
  /** ISO timestamp of the issue's own schedule, when it has one. */
  scheduledAt: string | null;
}

function esc(value: string): string {
  return value.replace(
    /[<>&"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] as string),
  );
}

function utcDay(iso: string | null): string {
  if (!iso) return 'bilinmiyor';
  const d = new Date(iso);
  // A fixed zone: the band's month is a UTC month, and a date that shifted with
  // the container's TZ would disagree with the meter it describes.
  return Number.isNaN(d.getTime()) ? 'bilinmiyor' : d.toISOString().slice(0, 10);
}

/** The org as the operator knows it: its name, with the slug to find it by. */
export function describeHoldingOrg(facts: Pick<NewsletterQuotaHoldFacts, 'orgName' | 'orgSlug'>): string {
  if (facts.orgName && facts.orgSlug) return `${facts.orgName} (${facts.orgSlug})`;
  return facts.orgName || facts.orgSlug || 'bilinmeyen organizasyon';
}

/** Subject + body of the one mail a held issue earns per month. */
export function buildNewsletterQuotaHoldAlert(facts: NewsletterQuotaHoldFacts): { subject: string; html: string } {
  const org = describeHoldingOrg(facts);
  const limit = facts.limit == null ? 'sınırsız' : String(facts.limit);
  const remaining = facts.remaining == null ? '—' : String(facts.remaining);
  return {
    subject: `[CRM] Bülten beklemede — ${org} yayın kotasını doldurdu`.slice(0, 180),
    html: [
      `<p>Bir bülten sayısı <b>${esc(org)}</b> organizasyonunun aylık yayın kotası yüzünden gönderilmiyor.</p>`,
      '<ul>',
      `<li>Sayı: ${esc(facts.subject)} (<code>${esc(facts.newsletterId)}</code>)</li>`,
      `<li>Planlanan tarih: ${utcDay(facts.scheduledAt)}</li>`,
      `<li>Bu ay kullanılan: ${facts.used} / ${esc(limit)} alıcı — kalan ${esc(remaining)}</li>`,
      `<li>Bu sayının ihtiyacı: ${facts.requested} alıcı</li>`,
      `<li>Sayaç sıfırlanıyor: ${utcDay(facts.resetsAt)} (UTC)</li>`,
      '</ul>',
      '<p>Hiçbir şey gönderilmedi ve sayı planlı kalıyor: sayaç izin verdiği ilk dispatch turunda kendiliğinden gider. ' +
        'Diğer organizasyonların bültenleri bundan etkilenmez. Beklemek istemiyorsan organizasyonun planını ' +
        'ya da — sınırı o koyuyorsa — <code>broadcastMonthlyRecipients</code> ayarını gözden geçir; sayıyı ' +
        'iptal etmek <code>/admin/newsletters</code> üzerinden mümkün.</p>',
      '<p>Bu uyarı her sayı için ayda bir kez gelir.</p>',
    ].join(''),
  };
}
