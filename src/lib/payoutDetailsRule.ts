// Payout details (IBAN + account holder) — shape, check and mask
// (docs/affiliate-module.md, #3115). PURE and dependency-free, so the partner's
// form and the server judge with one rule.
//
// The IBAN check is the ISO 13616 one every bank applies: two letters, two check
// digits, 11–30 alphanumerics, and the mod-97 remainder of the rearranged number
// equals 1. It catches a mistyped digit; it does not prove the account exists.

export const HOLDER_MAX_CHARS = 140;

export interface PayoutDetails {
  /** Normalised: upper case, no spaces. */
  iban: string;
  holder: string;
}

export type PayoutDetailsIssue = 'iban' | 'holder';

/** Removes spaces and dashes people paste, and upper-cases. */
export function normalizeIban(raw: string): string {
  return typeof raw === 'string' ? raw.replace(/[\s-]/g, '').toUpperCase() : '';
}

export function isValidIban(raw: string): boolean {
  const iban = normalizeIban(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  // Letters become two digits (A = 10 … Z = 35); the remainder is folded chunk by
  // chunk so no step leaves the safe-integer range.
  let remainder = 0;
  for (const ch of rearranged) {
    const value = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

export function parsePayoutDetails(input: unknown): { ok: true; details: PayoutDetails } | { ok: false; issues: PayoutDetailsIssue[] } {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const issues: PayoutDetailsIssue[] = [];
  const iban = typeof o.iban === 'string' ? normalizeIban(o.iban) : '';
  if (!isValidIban(iban)) issues.push('iban');
  const holder = typeof o.holder === 'string' ? o.holder.trim().replace(/\s+/g, ' ') : '';
  if (holder.length === 0 || holder.length > HOLDER_MAX_CHARS) issues.push('holder');
  return issues.length > 0 ? { ok: false, issues } : { ok: true, details: { iban, holder } };
}

/** What a partner (and every log or audit row) sees: the last four characters only. */
export function maskIban(iban: string): string {
  const n = normalizeIban(iban);
  return n.length <= 4 ? '••••' : `•••• ${n.slice(-4)}`;
}
