// The IP allowlist of a registered integration source (#2978) — the rule half,
// dependency-free so scripts/test/source-ip-allowlist.test.mjs pins it without a
// database and a client component may import it. The guard that applies it is
// src/lib/integrationSourceGuard.ts; the contract is
// docs/integrations/account-events.md § Security.
//
// WHAT IT DECIDES:
//   • which entries an operator may store (`parseAllowlist`): IPv4 / IPv6
//     addresses and CIDR blocks, each turned into ONE canonical spelling
//     (dotted quad; RFC 5952 compressed lower-case IPv6), so the stored text,
//     the admin screen and the CLI agree on what a list says;
//   • whether a client address is inside a stored list (`ipInAllowlist`).
//
// THE REFUSALS, each a typo that would otherwise widen or silently break the list:
//   • host bits set (`10.0.0.1/8`) — the operator meant either the address or
//     the block, and guessing either is wrong;
//   • a /0 — "allowlist on, everybody allowed" is the state a reader of the
//     screen would least expect;
//   • more than SOURCE_ALLOWLIST_MAX entries.
//
// FAIL CLOSED: an address that does not parse (the rate limiter's `'unknown'`
// when no trusted proxy header is there) is in no list, and a stored entry that
// no longer parses matches nothing — it never turns into "allow all".
//
// IPv4-mapped IPv6 (`::ffff:203.0.113.7`) is matched as the IPv4 address it
// carries, both as a client address and as a list entry.
//
// prisma/register-integration-source.mjs carries a plain-ESM mirror of this file
// (the server's Node 20 cannot import TS); the unit test compares the two on a
// corpus — change both in one commit.

export const SOURCE_ALLOWLIST_MAX = 50;
/** The stored column is @db.Text; the canonical list never comes near it. */
export const SOURCE_ALLOWLIST_TEXT_MAX = 4000;

export type AllowlistErrorCode = 'invalid' | 'host_bits' | 'too_broad' | 'too_many';

export interface AllowlistEntry {
  family: 4 | 6;
  /** The block's first address. */
  base: bigint;
  prefix: number;
  /** Canonical spelling: `a.b.c.d` / `a.b.c.d/n`, RFC 5952 IPv6 likewise. */
  text: string;
}

export interface ParsedAddress {
  family: 4 | 6;
  value: bigint;
}

const V4_OCTET = /^(0|[1-9]\d{0,2})$/;

export function parseIpv4(raw: string): bigint | null {
  const parts = raw.split('.');
  if (parts.length !== 4) return null;
  let value = BigInt(0);
  for (const p of parts) {
    if (!V4_OCTET.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    value = (value << BigInt(8)) | BigInt(n);
  }
  return value;
}

const V6_GROUP = /^[0-9a-f]{1,4}$/;

export function parseIpv6(raw: string): bigint | null {
  const s = raw.toLowerCase();
  if (!s || s.includes('%')) return null; // a zone id names an interface, not a host
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    const items = part.split(':');
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (i === items.length - 1 && item.includes('.')) {
        const v4 = parseIpv4(item);
        if (v4 === null) return null;
        out.push(Number(v4 >> BigInt(16)), Number(v4 & BigInt(0xffff)));
        continue;
      }
      if (!V6_GROUP.test(item)) return null;
      out.push(parseInt(item, 16));
    }
    return out;
  };
  const head = groupsOf(halves[0]);
  const tail = halves.length === 2 ? groupsOf(halves[1]) : [];
  if (!head || !tail) return null;
  // An embedded IPv4 is only allowed at the very end.
  if (halves.length === 2 && halves[0].includes('.')) return null;
  let groups: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  let value = BigInt(0);
  for (const g of groups) value = (value << BigInt(16)) | BigInt(g);
  return value;
}

const V4_MASK = (BigInt(1) << BigInt(32)) - BigInt(1);

/** An address of either family, IPv4-mapped IPv6 folded to IPv4; null when it is not one. */
export function parseAddress(raw: unknown): ParsedAddress | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/^\[|\]$/g, '');
  if (!s) return null;
  if (!s.includes(':')) {
    const v4 = parseIpv4(s);
    return v4 === null ? null : { family: 4, value: v4 };
  }
  const v6 = parseIpv6(s);
  if (v6 === null) return null;
  if (v6 >> BigInt(32) === BigInt(0xffff)) return { family: 4, value: v6 & V4_MASK };
  return { family: 6, value: v6 };
}

function formatIpv4(value: bigint): string {
  return [24, 16, 8, 0].map((shift) => String(Number((value >> BigInt(shift)) & BigInt(255)))).join('.');
}

/** RFC 5952: lower-case, leading zeros dropped, the longest run (≥ 2) of zero groups as `::`, the first on a tie. */
function formatIpv6(value: bigint): string {
  const groups: number[] = [];
  for (let i = 7; i >= 0; i--) groups.push(Number((value >> BigInt(i * 16)) & BigInt(0xffff)));
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLen < 2) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLen).join(':')}`;
}

export function formatAddress(addr: ParsedAddress): string {
  return addr.family === 4 ? formatIpv4(addr.value) : formatIpv6(addr.value);
}

/** One entry, or the reason it cannot be stored. */
export function parseAllowlistEntry(raw: string): { ok: true; entry: AllowlistEntry } | { ok: false; code: AllowlistErrorCode } {
  const s = raw.trim();
  const slash = s.indexOf('/');
  const addrPart = slash >= 0 ? s.slice(0, slash) : s;
  const prefixPart = slash >= 0 ? s.slice(slash + 1) : null;
  const addr = parseAddress(addrPart);
  if (!addr) return { ok: false, code: 'invalid' };
  // A mapped address written with a v6 prefix: the prefix counts from bit 0 of
  // the 128-bit form, so the IPv4 prefix is 96 less.
  const mapped = addr.family === 4 && addrPart.includes(':');
  const width = addr.family === 4 ? 32 : 128;
  let prefix = width;
  if (prefixPart !== null) {
    if (!/^\d{1,3}$/.test(prefixPart)) return { ok: false, code: 'invalid' };
    prefix = Number(prefixPart);
    if (mapped) {
      if (prefix < 96 || prefix > 128) return { ok: false, code: 'invalid' };
      prefix -= 96;
    }
    if (prefix > width) return { ok: false, code: 'invalid' };
  }
  if (prefix === 0) return { ok: false, code: 'too_broad' };
  const hostBits = BigInt(width - prefix);
  const hostMask = (BigInt(1) << hostBits) - BigInt(1);
  if ((addr.value & hostMask) !== BigInt(0)) return { ok: false, code: 'host_bits' };
  const text = prefix === width ? formatAddress(addr) : `${formatAddress(addr)}/${prefix}`;
  return { ok: true, entry: { family: addr.family, base: addr.value, prefix, text } };
}

export interface AllowlistParseResult {
  /** The canonical entries, de-duplicated, in the order given. Empty = no allowlist. */
  entries: AllowlistEntry[];
  errors: { value: string; code: AllowlistErrorCode }[];
}

/**
 * An operator's input — one string (separated by commas, spaces or new lines)
 * or a list of strings — as canonical entries plus every refusal.
 * The caller stores nothing unless `errors` is empty.
 */
export function parseAllowlist(input: string | readonly string[] | null | undefined): AllowlistParseResult {
  const raw = input === null || input === undefined ? [] : typeof input === 'string' ? [input] : input;
  const tokens = raw.flatMap((s) => (typeof s === 'string' ? s.split(/[\s,;]+/) : [''])).filter((s) => s !== '');
  const entries: AllowlistEntry[] = [];
  const errors: AllowlistParseResult['errors'] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const parsed = parseAllowlistEntry(token);
    if (!parsed.ok) {
      errors.push({ value: token.slice(0, 100), code: parsed.code });
      continue;
    }
    if (seen.has(parsed.entry.text)) continue;
    seen.add(parsed.entry.text);
    entries.push(parsed.entry);
  }
  if (entries.length > SOURCE_ALLOWLIST_MAX) errors.push({ value: String(entries.length), code: 'too_many' });
  return { entries, errors };
}

/** The stored column: canonical entries joined by `,`, or null for "no allowlist". */
export function serializeAllowlist(entries: readonly AllowlistEntry[]): string | null {
  return entries.length ? entries.map((e) => e.text).join(',') : null;
}

/** The stored column as entries. An entry that no longer parses is dropped — it then matches nothing. */
export function storedAllowlist(stored: string | null | undefined): AllowlistEntry[] | null {
  if (stored === null || stored === undefined || stored.trim() === '') return null;
  const out: AllowlistEntry[] = [];
  for (const token of stored.split(',')) {
    const parsed = parseAllowlistEntry(token);
    if (parsed.ok) out.push(parsed.entry);
  }
  return out;
}

/** The stored column as display strings (the admin screen, the API answer). */
export function allowlistTexts(stored: string | null | undefined): string[] {
  return (storedAllowlist(stored) ?? []).map((e) => e.text);
}

/** Is `clientIp` inside one of `entries`? An unparsable address is in none. */
export function ipInAllowlist(clientIp: unknown, entries: readonly AllowlistEntry[]): boolean {
  const addr = parseAddress(clientIp);
  if (!addr) return false;
  const width = addr.family === 4 ? 32 : 128;
  for (const e of entries) {
    if (e.family !== addr.family) continue;
    const shift = BigInt(width - e.prefix);
    if (addr.value >> shift === e.base >> shift) return true;
  }
  return false;
}
