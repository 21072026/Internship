// The public employer page (#1867, docs/employer-page.md) — the pure half,
// unit-tested in scripts/test/employer-page.test.mjs.
//
// /employers/<slug> exists only for a company that opted in (`isPublicProfile`)
// AND is VERIFIED (#1865). Anything else is a 404 — the same answer as a slug
// nobody holds — never an empty page that would confirm the company exists.
// The page never carries `contactEmail`, `address` or any other internal field.

// No runtime imports, so the unit test loads it under plain `node --test`; the
// name → slug step is `kebabSlug()` in ./transliterate (Turkish-safe), applied
// by the caller (src/lib/employerPageStore.ts).

export const EMPLOYER_SLUG_MAX = 60;

/** The base slug for a company: its kebab-cased name, or `employer` when nothing is left. */
export function employerSlugBase(kebabName: string): string {
  return kebabName || 'employer';
}

/** The n-th candidate for a taken base: base, base-2, base-3, … (always within the cap). */
export function employerSlugCandidate(base: string, n: number): string {
  if (n <= 1) return base;
  const suffix = `-${n}`;
  return `${base.slice(0, EMPLOYER_SLUG_MAX - suffix.length).replace(/-+$/g, '')}${suffix}`;
}

export const EMPLOYER_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isEmployerSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length <= EMPLOYER_SLUG_MAX && EMPLOYER_SLUG_PATTERN.test(value);
}

/** The one rule: may this company be shown at its public URL? */
export function isPublicEmployer(c: { isPublicProfile: boolean; verificationStatus: string | null | undefined; slug: string | null }): boolean {
  return c.isPublicProfile && c.verificationStatus === 'VERIFIED' && !!c.slug;
}

/** A website a person typed: https only, no credentials — it becomes a link on a public page. */
export function isSafeWebsiteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !!url.hostname;
  } catch {
    return false;
  }
}
