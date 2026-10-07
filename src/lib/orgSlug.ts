// An organization's URL-safe slug (#544, #2065). Pure and client-safe: the
// provisioning wizard derives the slug from the name as you type with exactly
// the rule the server applies on create, so what the field shows is what gets
// stored.

import { transliterate } from './transliterate';

export const ORG_SLUG_MAX = 60;

/**
 * Lowercase, alphanumerics and single hyphens, no leading or trailing hyphen.
 * Turkish and accented letters are transliterated first, so "Çalışkan Ünlü"
 * becomes `caliskan-unlu` rather than losing every non-ASCII letter.
 */
export function slugifyOrg(input: string): string {
  return transliterate(input)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, ORG_SLUG_MAX)
    .replace(/-+$/g, '');
}
