// A lead that came in through an affiliate link carries the Source
// `affiliate:<code>` (src/lib/leadSourceName.ts). This is the inverse: the
// partner code a source name names, or null. Pure — the badge, the board list
// and the partner portal read the code the same way (#3647).

/** The prefix leadSourceName() writes for an affiliate reference. */
export const AFFILIATE_SOURCE_PREFIX = 'affiliate:';

/** The partner code in an `affiliate:<code>` source name, or null for any other source. */
export function affiliateCodeOf(sourceName: string | null | undefined): string | null {
  if (typeof sourceName !== 'string' || !sourceName.startsWith(AFFILIATE_SOURCE_PREFIX)) return null;
  const code = sourceName.slice(AFFILIATE_SOURCE_PREFIX.length).trim();
  return code || null;
}

/** The source name a partner's leads carry. */
export function affiliateSourceName(code: string): string {
  return `${AFFILIATE_SOURCE_PREFIX}${code}`;
}
