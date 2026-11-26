// The PRs a feedback report was worked in (#3928) — one rule, dependency-free
// so a plain `node --experimental-strip-types` unit test can import it.
//
// An admin types the link in by hand (no GitHub automation, decision
// 2026-11-25). What is accepted is deliberately narrow: a pull request of THIS
// repository, as GitHub prints it, so a stored link is never a host or a path
// someone chose. The list is ADMIN ONLY — see the schema comment on
// `SupportReport.prLinks`.

/** The repository a feedback PR link may point at. */
export const SUPPORT_PR_REPO = '21072026/Internship';
/** How many PRs one report keeps — a report is fixed in one or a few. */
export const SUPPORT_PR_LINK_MAX = 10;

export interface SupportPrLink {
  url: string;
  number: number;
  addedAt: string;
  addedById: string | null;
}

const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d{1,7})\/?(?:[?#].*)?$/;

export type ParsedPrLink = { ok: true; url: string; number: number } | { ok: false; error: 'invalid_pr_url' | 'wrong_repo' };

/** A typed link → its canonical form (`https://github.com/<repo>/pull/<n>`), or why not. */
export function parsePrLink(input: unknown): ParsedPrLink {
  if (typeof input !== 'string') return { ok: false, error: 'invalid_pr_url' };
  const m = PR_URL.exec(input.trim());
  if (!m) return { ok: false, error: 'invalid_pr_url' };
  if (m[1].toLowerCase() !== SUPPORT_PR_REPO.toLowerCase()) return { ok: false, error: 'wrong_repo' };
  const number = Number(m[2]);
  if (!Number.isSafeInteger(number) || number < 1) return { ok: false, error: 'invalid_pr_url' };
  return { ok: true, url: `https://github.com/${SUPPORT_PR_REPO}/pull/${number}`, number };
}

/** The stored column back as a clean list; anything malformed is dropped. */
export function readPrLinks(value: unknown): SupportPrLink[] {
  if (!Array.isArray(value)) return [];
  const out: SupportPrLink[] = [];
  for (const v of value) {
    if (!v || typeof v !== 'object') continue;
    const row = v as Record<string, unknown>;
    const parsed = parsePrLink(row.url);
    if (!parsed.ok) continue;
    out.push({
      url: parsed.url,
      number: parsed.number,
      addedAt: typeof row.addedAt === 'string' ? row.addedAt : '',
      addedById: typeof row.addedById === 'string' ? row.addedById : null,
    });
  }
  return out;
}

export type PrLinkChange =
  | { ok: true; links: SupportPrLink[]; changed: boolean }
  | { ok: false; error: 'invalid_pr_url' | 'wrong_repo' | 'too_many' };

/** Add one link; the same PR twice is a no-op, never a duplicate. */
export function addPrLink(current: unknown, input: unknown, actorId: string, now: Date): PrLinkChange {
  const parsed = parsePrLink(input);
  if (!parsed.ok) return parsed;
  const links = readPrLinks(current);
  if (links.some((l) => l.number === parsed.number)) return { ok: true, links, changed: false };
  if (links.length >= SUPPORT_PR_LINK_MAX) return { ok: false, error: 'too_many' };
  return { ok: true, links: [...links, { url: parsed.url, number: parsed.number, addedAt: now.toISOString(), addedById: actorId }], changed: true };
}

/** Remove the link to PR `number`; an absent one is a no-op. */
export function removePrLink(current: unknown, number: number): { links: SupportPrLink[]; changed: boolean } {
  const links = readPrLinks(current);
  const next = links.filter((l) => l.number !== number);
  return { links: next, changed: next.length !== links.length };
}

const ISSUE_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d{1,7})\/?(?:[?#].*)?$/;

export type ParsedIssueLink = { ok: true; url: string; number: number } | { ok: false; error: 'invalid_issue_url' | 'wrong_repo' };

/**
 * The issue the feedback review opened for a report (#3937): an issue of THIS
 * repository, stored as `https://github.com/<repo>/issues/<n>`. The same
 * narrow rule as a PR link above.
 */
export function parseIssueLink(input: unknown): ParsedIssueLink {
  if (typeof input !== 'string') return { ok: false, error: 'invalid_issue_url' };
  const m = ISSUE_URL.exec(input.trim());
  if (!m) return { ok: false, error: 'invalid_issue_url' };
  if (m[1].toLowerCase() !== SUPPORT_PR_REPO.toLowerCase()) return { ok: false, error: 'wrong_repo' };
  const number = Number(m[2]);
  if (!Number.isSafeInteger(number) || number < 1) return { ok: false, error: 'invalid_issue_url' };
  return { ok: true, url: `https://github.com/${SUPPORT_PR_REPO}/issues/${number}`, number };
}
