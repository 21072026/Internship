// Partner payout details: the account holder and the IBAN the admin pays into
// by hand (docs/affiliate-module.md, decisions 9 and 10).
//
// PURE: validation and the stored shape only. Sealing is done by the route with
// src/lib/secretBox.ts (purpose `affiliate.payout`), so this file never holds a key.

export interface PayoutDetails {
  accountHolder: string;
  /** Normalised: upper case, no spaces. */
  iban: string;
}

/** Upper case, no whitespace. Display formatting is the caller's job. */
export function normalizeIban(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

/**
 * ISO 13616 check: country and check digits, a 11–30 character BBAN, and the
 * mod-97 rule (moving the first four characters to the end must give 1 mod 97).
 * Letters count as 10–35. Country-specific lengths are not checked here.
 */
export function isValidIban(raw: string): boolean {
  const iban = normalizeIban(raw);
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const value = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of value) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

/** The plaintext that gets sealed. Never logged. */
export function encodePayoutDetails(details: PayoutDetails): string {
  return JSON.stringify({ accountHolder: details.accountHolder.trim(), iban: normalizeIban(details.iban) });
}

/** Parse the opened plaintext; null when the stored value is not in this shape. */
export function decodePayoutDetails(json: string): PayoutDetails | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { accountHolder, iban } = value as Record<string, unknown>;
  if (typeof accountHolder !== 'string' || typeof iban !== 'string') return null;
  return { accountHolder, iban: normalizeIban(iban) };
}
