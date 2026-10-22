// The partner contract and who may read affiliate rows (docs/affiliate-module.md, #3115).
//
// PURE and dependency-free, so the admin form, the server and a unit test read one
// rule. Three questions live here:
//
// - Is this a valid contract (one text per supported locale, bounded)?
// - Did the contract CHANGE? Texts are compared locale by locale in a fixed order.
//   A JSON column does not keep key order (MySQL 8 stores keys sorted), so
//   comparing serialized objects would call an unchanged contract "changed" and
//   ask every partner to accept it again on every save.
// - Must this partner accept before the portal and its API answer?

export const CONTRACT_LOCALES = ['en', 'tr', 'de'] as const;
export type ContractLocale = (typeof CONTRACT_LOCALES)[number];
export type ContractTexts = Partial<Record<ContractLocale, string>>;

export const CONTRACT_MAX_CHARS = 50_000;

export interface ContractIssue {
  locale: string;
  code: 'locale' | 'type' | 'too_long';
}

export type ContractParseResult = { ok: true; texts: ContractTexts } | { ok: false; issues: ContractIssue[] };

const isContractLocale = (v: string): v is ContractLocale => (CONTRACT_LOCALES as readonly string[]).includes(v);

/** Line endings are normalised; an empty or whitespace-only text means "no text for this locale". */
function normaliseText(v: string): string {
  return v.replace(/\r\n?/g, '\n');
}

/** Validates untrusted contract texts (a request body). Every problem at once. */
export function parseContractTexts(input: unknown): ContractParseResult {
  const issues: ContractIssue[] = [];
  const texts: ContractTexts = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, issues: [{ locale: '*', code: 'type' }] };
  for (const [locale, value] of Object.entries(input as Record<string, unknown>)) {
    if (!isContractLocale(locale)) {
      issues.push({ locale, code: 'locale' });
      continue;
    }
    if (value === null || value === undefined) continue;
    if (typeof value !== 'string') {
      issues.push({ locale, code: 'type' });
      continue;
    }
    const text = normaliseText(value);
    if (text.length > CONTRACT_MAX_CHARS) issues.push({ locale, code: 'too_long' });
    else if (text.trim().length > 0) texts[locale] = text;
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, texts };
}

/** A stored value (JSON column), read defensively: anything malformed reads as "no contract". */
export function readStoredContract(stored: unknown): ContractTexts {
  const parsed = parseContractTexts(stored ?? {});
  return parsed.ok ? parsed.texts : {};
}

/** The contract as an ordered list of [locale, text] — the one shape that is compared. */
export function canonicalContract(texts: ContractTexts): [ContractLocale, string][] {
  return CONTRACT_LOCALES.filter((l) => texts[l] !== undefined).map((l) => [l, texts[l] as string]);
}

/** True when saving `next` over `stored` changes what a partner agrees to. */
export function contractChanged(stored: unknown, next: ContractTexts): boolean {
  const a = canonicalContract(readStoredContract(stored));
  const b = canonicalContract(next);
  return a.length !== b.length || a.some(([l, t], i) => b[i][0] !== l || b[i][1] !== t);
}

/** The text a partner reads: their locale, else English, else the first one there is. */
export function contractTextFor(texts: ContractTexts, locale: string): { locale: ContractLocale; text: string } | null {
  const order: ContractLocale[] = [...(isContractLocale(locale) ? [locale] : []), 'en', ...CONTRACT_LOCALES];
  for (const l of order) {
    const text = texts[l];
    if (text !== undefined) return { locale: l, text };
  }
  return null;
}

export interface ContractState {
  /** 0 = no contract was ever published. */
  currentVersion: number;
  /** The highest version this partner accepted; 0 = none. */
  acceptedVersion: number;
  /** The portal and its API refuse until this is false. */
  mustAccept: boolean;
}

export function contractStateFor(currentVersion: number, acceptedVersions: readonly number[]): ContractState {
  const acceptedVersion = acceptedVersions.reduce((m, v) => Math.max(m, v), 0);
  return { currentVersion, acceptedVersion, mustAccept: currentVersion > 0 && !acceptedVersions.includes(currentVersion) };
}

export type AffiliateActor =
  | { role: 'ADMIN'; orgId: string }
  | { role: 'AFFILIATE'; orgId: string; partnerId: string }
  | { role: string; orgId: string | null };

/**
 * The ONE "which affiliate rows may this actor read" filter. ADMIN: the whole
 * programme of their organisation. AFFILIATE: their own partner's rows only.
 * Anyone else: nothing (null). A row outside the filter answers 404, never 403 —
 * a 403 would confirm that the id exists.
 */
export function affiliateRowScope(actor: AffiliateActor): { orgId: string; partnerId?: string } | null {
  if (!actor.orgId) return null;
  if (actor.role === 'ADMIN') return { orgId: actor.orgId };
  if (actor.role === 'AFFILIATE' && 'partnerId' in actor && actor.partnerId) return { orgId: actor.orgId, partnerId: actor.partnerId };
  return null;
}
