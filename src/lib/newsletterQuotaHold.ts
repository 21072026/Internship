// A newsletter issue the broadcast quota is holding (#2335): which due issues
// one dispatch tick attempts, and what the operator is told about the ones that
// are held. Pure and dependency-free — no Prisma, no nodemailer, no node-cron —
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
//   2. Every due issue is metered ON ITS OWN, exactly as before: a later issue
//      of a tenant that fits its band goes out even while an older, larger one
//      of the same tenant is held. The unit the quota refuses is the issue,
//      never the tenant's queue. A tenant-wide "wait behind the held one" would
//      be a second silent stall — the waiting issue fits, so nothing would ever
//      mark it held.
//   3. What bounds the cost of held attempts is a PER-TENANT cap: a tenant gets
//      at most `NEWSLETTER_HELD_PER_TENANT` held attempts per tick, and only its
//      further SCHEDULED issues are deferred once it has used them. The cap is
//      the old tick's own size, so no tenant is worse off than under the
//      ten-oldest tick it replaces, and it is per tenant so that no tenant's
//      backlog can use up anybody else's reach.
//   4. A RESUME (a SENDING row, a run that died half-way) is never deferred. It
//      is never metered, so it cannot be held, and it is the one row that must
//      not wait: SENDING cannot be edited, cancelled or re-sent, and this tick
//      is the only thing that finishes it.
//   5. Order is otherwise the caller's (oldest `scheduledAt` first). The rule
//      never reorders; it only skips.

/** How many attempts that could mail someone one tick makes at most. */
export const NEWSLETTER_TICK_BUDGET = 10;

/** How many held attempts one tenant gets per tick (clause 3). */
export const NEWSLETTER_HELD_PER_TENANT = NEWSLETTER_TICK_BUDGET;

export interface DueNewsletterRef {
  id: string;
  /** The issue's tenant. `null` (a legacy row) is its own bucket. */
  orgId: string | null;
  /** `'SENDING'` marks a resume, which is never deferred (clause 4). */
  status: string;
}

export interface NewsletterTickRun<R> {
  /** Every attempt's result, held ones included, in the order attempted. */
  results: R[];
  /** SCHEDULED issues left for the next tick because their tenant used up its held attempts. */
  deferred: string[];
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
  options: { isHeld: (result: R) => boolean; budget?: number; heldPerTenant?: number },
): Promise<NewsletterTickRun<R>> {
  const budget = options.budget ?? NEWSLETTER_TICK_BUDGET;
  const heldPerTenant = options.heldPerTenant ?? NEWSLETTER_HELD_PER_TENANT;
  const heldBy = new Map<string, number>();
  const results: R[] = [];
  const deferred: string[] = [];
  let spent = 0;

  for (const issue of due) {
    if (spent >= budget) break;
    const tenant = issue.orgId ?? '';
    const resume = issue.status === 'SENDING';
    if (!resume && (heldBy.get(tenant) ?? 0) >= heldPerTenant) {
      deferred.push(issue.id);
      continue;
    }
    const result = await attempt(issue);
    if (result !== null && options.isHeld(result)) {
      heldBy.set(tenant, (heldBy.get(tenant) ?? 0) + 1);
      results.push(result);
      continue;
    }
    spent++;
    if (result !== null) results.push(result);
  }

  return { results, deferred, heldOrgs: [...heldBy.keys()] };
}

// ── The operator alert ─────────────────────────────────────────────────────
// A held issue that nobody pressed Send on (the cadence's own, or one an admin
// scheduled for a date) used to produce a warning line in the server log every
// fifteen minutes and nothing else. The alert makes it loud ONCE: the dispatcher
// writes one ActivityLog row per held issue per broadcast month and mails this
// to ALERT_EMAIL_TO — one mail per tick, covering every issue that tick newly
// found held. It is Turkish for the same reason the dead-letter alert is
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

function holdBlock(facts: NewsletterQuotaHoldFacts): string {
  const limit = facts.limit == null ? 'sınırsız' : String(facts.limit);
  const remaining = facts.remaining == null ? '—' : String(facts.remaining);
  return [
    `<p><b>${esc(describeHoldingOrg(facts))}</b></p>`,
    '<ul>',
    `<li>Sayı: ${esc(facts.subject)} (<code>${esc(facts.newsletterId)}</code>)</li>`,
    `<li>Planlanan tarih: ${utcDay(facts.scheduledAt)}</li>`,
    `<li>Bu ay kullanılan: ${facts.used} / ${esc(limit)} alıcı — kalan ${esc(remaining)}</li>`,
    `<li>Bu sayının ihtiyacı: ${facts.requested} alıcı</li>`,
    `<li>Sayaç sıfırlanıyor: ${utcDay(facts.resetsAt)} (UTC)</li>`,
    '</ul>',
  ].join('');
}

/**
 * Subject + body of the ONE mail a dispatch tick sends about the issues it
 * newly found held — however many there are, so a tenant with several queued
 * issues produces one mail, not one per issue. Each issue appears in at most
 * one such mail per broadcast month (the caller dedupes on ActivityLog).
 */
export function buildNewsletterQuotaHoldAlert(held: readonly NewsletterQuotaHoldFacts[]): { subject: string; html: string } {
  const orgs = [...new Set(held.map((facts) => describeHoldingOrg(facts)))];
  const count = held.length === 1 ? 'Bülten' : `${held.length} bülten`;
  const who = orgs.length === 1 ? `${orgs[0]} yayın kotasını doldurdu` : `${orgs.length} organizasyonun yayın kotası dolu`;
  return {
    subject: `[CRM] ${count} beklemede — ${who}`.slice(0, 180),
    html: [
      held.length === 1
        ? '<p>Bir bülten sayısı, organizasyonunun aylık yayın kotası yüzünden gönderilmiyor.</p>'
        : `<p>${held.length} bülten sayısı, organizasyonlarının aylık yayın kotası yüzünden gönderilmiyor.</p>`,
      ...held.map(holdBlock),
      '<p>Hiçbir şey gönderilmedi ve sayılar planlı kalıyor: her biri, sayacın izin verdiği ilk dispatch turunda ' +
        'kendiliğinden gider. Diğer organizasyonların bültenleri bundan etkilenmez. Beklemek istemiyorsan ' +
        'organizasyonun planını ya da — sınırı o koyuyorsa — <code>broadcastMonthlyRecipients</code> ayarını ' +
        'gözden geçir; bir sayıyı iptal etmek <code>/admin/newsletters</code> üzerinden mümkün.</p>',
      '<p>Bu uyarı her sayı için ayda bir kez gelir; aynı dispatch turunda beklemeye düşen sayılar tek bir ' +
        'e-postada toplanır.</p>',
    ].join(''),
  };
}
