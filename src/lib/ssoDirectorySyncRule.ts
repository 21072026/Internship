// SSO directory sync (#1943) — the rule, pure and dependency-free so
// `node --test --experimental-strip-types` loads it directly
// (scripts/test/sso-directory-sync.test.mjs).
//
// WHAT IT IS: on every SSO sign-in the IdP is asked "who is this person today?"
// and the answer refreshes the profile — department, city, title, a tenant's
// own attributes, the photo. A tenant maps an IdP claim to a TARGET once
// (`SsoAttributeMapping`), and this module turns a verified claim set into a
// plan; src/lib/ssoDirectorySync.ts applies it.
//
// THE RULES, none of them negotiable:
//   1. Targets are an ALLOWLIST: the profile fields in SSO_PROFILE_FIELDS, the
//      photo, or `attr:<key>` of one of the org's own attributes. Never email,
//      role, orgId, a password or a flag — identity and access are decided by
//      provisioning and the role mapping (#1940), not by a profile refresh.
//   2. What may be OVERWRITTEN is not decided here: the plan goes through
//      `planFieldUpdates()` (src/lib/externalSyncPolicy.ts), the one policy
//      the roster feed shares. Non-authoritative (the default) fills gaps only;
//      `Organization.ssoAuthoritative` lets the IdP win a disagreement.
//   3. A claim the IdP did not send is no opinion — nothing is blanked.
//   4. A value that does not fit its target (too long, an unknown time zone, a
//      SELECT value that is not an option) is dropped and REPORTED by target
//      name, never by value: the sign-in still succeeds.
//   5. The photo is a URL (OIDC `picture`, a SAML URL attribute) or inline
//      base64 bytes (AD's `thumbnailPhoto`). Either way the bytes are fetched /
//      decoded and stored like an uploaded avatar — never hotlinked.

import { sniffFamily } from './fileType';
import { normalizeValue } from './orgAttributesRule';

/** User columns an IdP claim may refresh. Each is a plain String? on User. */
export const SSO_PROFILE_FIELDS = ['fullName', 'department', 'targetPosition', 'city', 'country', 'timezone', 'phone'] as const;
export type SsoProfileField = (typeof SSO_PROFILE_FIELDS)[number];

export const SSO_PHOTO_TARGET = 'photo';
export const SSO_ATTRIBUTE_PREFIX = 'attr:';

/** The VARCHAR(191) every target column shares. */
export const MAX_SYNC_VALUE_LENGTH = 191;
/** The avatar cap the upload route enforces, kept identical on purpose. */
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

export interface AttributeMappingRow {
  claim: string;
  target: string;
}

export interface SyncableAttribute {
  id: string;
  key: string;
  type: string;
  options?: unknown;
}

export function isProfileField(target: string): target is SsoProfileField {
  return (SSO_PROFILE_FIELDS as readonly string[]).includes(target);
}

/** The attribute key of an `attr:<key>` target, or null. */
export function attributeKeyOf(target: string): string | null {
  if (!target.startsWith(SSO_ATTRIBUTE_PREFIX)) return null;
  const key = target.slice(SSO_ATTRIBUTE_PREFIX.length);
  return /^[a-z][a-z0-9_]{0,63}$/.test(key) ? key : null;
}

/** Rule 1 — a target is a profile field, the photo, or `attr:<key>`. */
export function isSyncTarget(target: string): boolean {
  return isProfileField(target) || target === SSO_PHOTO_TARGET || attributeKeyOf(target) !== null;
}

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** One claim value for a profile field, or null when it does not fit (rule 4). */
export function normalizeProfileValue(field: SsoProfileField, raw: string): string | null {
  const v = raw.trim();
  if (!v || v.length > MAX_SYNC_VALUE_LENGTH) return null;
  if (field === 'timezone' && !isTimeZone(v)) return null;
  return v;
}

export interface SyncPlan {
  /** Profile fields the IdP has an opinion on — handed to planFieldUpdates(). */
  fields: Partial<Record<SsoProfileField, string>>;
  /** attributeId → normalised value, for the org's own attributes. */
  attributes: Record<string, string>;
  /** The photo claim's value: a URL or inline base64, still unverified. */
  photo: string | null;
  /** Targets whose claim was present but unusable — names only (rule 4). */
  rejected: string[];
}

/**
 * The plan for one sign-in. The first value of a multi-valued claim is used
 * (a profile field holds one value). A mapping to an attribute the org no
 * longer has is skipped silently — deleting an attribute is the admin's call.
 */
export function planSsoProfileSync(
  mappings: readonly AttributeMappingRow[],
  claims: Record<string, string[]>,
  attributes: readonly SyncableAttribute[],
): SyncPlan {
  const plan: SyncPlan = { fields: {}, attributes: {}, photo: null, rejected: [] };
  const byKey = new Map(attributes.map((a) => [a.key, a]));
  for (const m of mappings) {
    const raw = claims[m.claim]?.find((v) => v.trim().length > 0);
    if (raw === undefined) continue; // rule 3
    if (isProfileField(m.target)) {
      const v = normalizeProfileValue(m.target, raw);
      if (v === null) plan.rejected.push(m.target);
      else plan.fields[m.target] = v;
      continue;
    }
    if (m.target === SSO_PHOTO_TARGET) {
      plan.photo = raw.trim();
      continue;
    }
    const key = attributeKeyOf(m.target);
    const attr = key ? byKey.get(key) : undefined;
    if (!attr) continue;
    const r = normalizeValue(attr, raw);
    if (r.ok) plan.attributes[attr.id] = r.value;
    else plan.rejected.push(m.target);
  }
  return plan;
}

/**
 * Which attribute values may be written, by the same policy as the profile
 * fields (externalSyncPolicy): a missing value is a gap the IdP fills, a
 * different one is the tenant's data unless the IdP is authoritative.
 */
export function planAttributeWrites(
  incoming: Record<string, string>,
  current: ReadonlyMap<string, string>,
  authoritative: boolean,
): { writes: Record<string, string>; withheld: string[] } {
  const writes: Record<string, string> = {};
  const withheld: string[] = [];
  for (const [id, value] of Object.entries(incoming)) {
    const have = current.get(id);
    if (have === value) continue;
    if (have !== undefined && have.trim() !== '' && !authoritative) {
      withheld.push(id);
      continue;
    }
    writes[id] = value;
  }
  return { writes, withheld };
}

export type PhotoSource = { kind: 'url'; url: string } | { kind: 'inline'; bytes: Uint8Array } | { kind: 'invalid' };

/**
 * What a photo claim is. An absolute URL is fetched (through the SSRF guard,
 * by the caller); anything else must be base64 that decodes to at most
 * MAX_PHOTO_BYTES — what the bytes ARE is checked after, by signature.
 */
export function classifyPhotoClaim(value: string): PhotoSource {
  const v = value.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return { kind: 'url', url: v };
  const compact = v.replace(/\s+/g, '');
  if (!compact || compact.length > Math.ceil((MAX_PHOTO_BYTES * 4) / 3) + 4) return { kind: 'invalid' };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) return { kind: 'invalid' };
  const bytes = Uint8Array.from(Buffer.from(compact, 'base64'));
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PHOTO_BYTES) return { kind: 'invalid' };
  return { kind: 'inline', bytes };
}

const PHOTO_TYPES: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/** The image type the bytes carry, from their signature (the upload routes' sniffer); null for anything else. */
export function photoContentType(bytes: Uint8Array): string | null {
  const family = sniffFamily(bytes);
  return family ? PHOTO_TYPES[family] ?? null : null;
}
