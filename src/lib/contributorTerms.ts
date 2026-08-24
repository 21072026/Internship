import { createHmac } from 'crypto';
import { prisma } from '@/lib/prisma';
import { requireServerSecret } from '@/lib/serverSecret';
import { clientIp, type HeaderSource } from '@/lib/clientIp';

/**
 * Contributor terms, accepted in the app instead of on paper (#1025).
 * Design and the legal reasoning: docs/legal/contributor-terms-in-app.md.
 *
 * Five properties make a click-wrap hold up, and every one of them is a
 * decision in this file rather than a detail:
 *
 *   1. the text is visible BEFORE the click — so the caller renders the body,
 *      never just a link (getActiveTerms returns the body for that reason);
 *   2. the box starts UNTICKED — acceptance is an act, not a default;
 *   3. the text is VERSIONED — a new version is a new row, never an edit, so
 *      the exact wording someone agreed to can be produced years later;
 *   4. EVIDENCE is stored — who, which version, when, from what client;
 *   5. the person can READ IT BACK — acceptanceHistory() feeds that page.
 *
 * The scope split (platform vs. project) is not tidiness either: § 40 UrhG
 * makes a single blanket "everything I ever write" grant weak, so the design is
 * a chain of specific acceptances instead.
 */

export const DEFAULT_TERMS_KEY = 'default';

/** Locales a terms text may exist in. The authoritative one is a row flag. */
export type TermsLocale = 'en' | 'tr' | 'de';

export interface ActiveTerms {
  key: string;
  version: string;
  locale: string;
  isAuthoritative: boolean;
  body: string;
  effectiveFrom: Date;
  /** The locale that actually binds, when the reader is shown a translation. */
  authoritativeLocale: string | null;
}

/**
 * The terms in force for `key`, preferring the reader's locale.
 *
 * Falls back to the authoritative text rather than to nothing: being shown the
 * binding English is correct; being shown an empty page because no Turkish
 * translation exists is not.
 */
export async function getActiveTerms(
  key: string = DEFAULT_TERMS_KEY,
  locale: string = 'en',
  now: Date = new Date()
): Promise<ActiveTerms | null> {
  const rows = await prisma.contributorTerms.findMany({
    where: { key, effectiveFrom: { lte: now } },
    orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
  });
  if (rows.length === 0) return null;

  // Newest effective version wins; within it, pick the reader's locale.
  const newest = rows[0];
  const sameVersion = rows.filter((r) => r.version === newest.version);
  const authoritative = sameVersion.find((r) => r.isAuthoritative) ?? null;
  const chosen = sameVersion.find((r) => r.locale === locale) ?? authoritative ?? newest;

  return {
    key: chosen.key,
    version: chosen.version,
    locale: chosen.locale,
    isAuthoritative: chosen.isAuthoritative,
    body: chosen.body,
    effectiveFrom: chosen.effectiveFrom,
    authoritativeLocale: authoritative && authoritative.locale !== chosen.locale ? authoritative.locale : null,
  };
}

/**
 * Has this user accepted the CURRENT version?
 *
 * Deliberately version-sensitive: an acceptance of 1.0 says nothing about 1.1,
 * which is the whole point of versioning the text. With no terms configured the
 * answer is `true` — an installation that has not defined any terms must not
 * lock its contributors out of the product.
 */
export async function hasAcceptedContributorTerms(
  userId: string,
  opts: { termsKey?: string; projectId?: string | null } = {}
): Promise<boolean> {
  const key = opts.termsKey ?? DEFAULT_TERMS_KEY;
  const active = await getActiveTerms(key);
  if (!active) return true;

  const row = await prisma.contributorTermsAcceptance.findFirst({
    where: { userId, termsKey: key, version: active.version, projectId: opts.projectId ?? null },
    select: { id: true },
  });
  return !!row;
}

/**
 * Hash the evidence rather than storing it.
 *
 * The question an acceptance record has to answer is "was this the same client",
 * not "where does this person live". An HMAC with the server secret gives that
 * without keeping an address, and matches how the rest of the app treats an IP.
 */
function evidenceHash(value: string | null | undefined): string | null {
  if (!value) return null;
  return createHmac('sha256', requireServerSecret()).update(value).digest('hex').slice(0, 32);
}

export async function acceptTerms(
  userId: string,
  opts: { termsKey?: string; projectId?: string | null; request?: HeaderSource } = {}
) {
  const key = opts.termsKey ?? DEFAULT_TERMS_KEY;
  const active = await getActiveTerms(key);
  if (!active) throw new Error(`No contributor terms are configured for key "${key}"`);

  const ip = opts.request ? clientIp(opts.request) : null;
  const ua = opts.request?.headers.get('user-agent') ?? null;

  // Idempotent by hand, not by upsert. The compound unique
  // (userId, termsKey, version, projectId) does NOT deduplicate platform-level
  // rows: in MySQL a UNIQUE index treats every NULL as distinct, so two clicks
  // with projectId = NULL would both insert. The index still does its job for
  // project-scoped acceptances; this covers the case it cannot.
  //
  // Re-accepting must also NOT move acceptedAt — the first time they agreed is
  // the fact the evidence record exists to preserve.
  const existing = await prisma.contributorTermsAcceptance.findFirst({
    where: { userId, termsKey: key, version: active.version, projectId: opts.projectId ?? null },
  });
  if (existing) return existing;

  return prisma.contributorTermsAcceptance.create({
    data: {
      userId,
      termsKey: key,
      version: active.version,
      projectId: opts.projectId ?? null,
      ipHash: evidenceHash(ip),
      uaHash: evidenceHash(ua),
    },
  });
}

/** Everything this user has accepted, newest first — for the read-back page. */
export async function acceptanceHistory(userId: string) {
  return prisma.contributorTermsAcceptance.findMany({
    where: { userId },
    orderBy: { acceptedAt: 'desc' },
    select: { termsKey: true, version: true, projectId: true, acceptedAt: true },
  });
}
