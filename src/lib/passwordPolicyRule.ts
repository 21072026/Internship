// The password policy (#1544) — the rules half, dependency-free so the same
// code runs in the browser (the sign-up, reset and account forms) and on the
// server (register, reset, account), and scripts/test/password-policy.test.mjs
// can pin every decision without a database. The settings-backed resolution,
// the breach lookup and the HTTP shape live in src/lib/password.ts and
// src/lib/breachedPassword.ts.
//
// The rules are DATA: five settings (passwordMinLength, passwordRequireUpper,
// passwordRequireLower, passwordRequireDigit, passwordRequireSymbol) read
// through the per-org settings chain. The code default is the policy the app
// always had — 8 characters, one upper, one lower — so a deployment that never
// touches the settings behaves exactly as before.

export interface PasswordPolicy {
  minLength: number;
  requireUpper: boolean;
  requireLower: boolean;
  requireDigit: boolean;
  requireSymbol: boolean;
}

/** The floor an admin cannot go under: today's rule. Weakening it is not configurable. */
export const PASSWORD_MIN_LENGTH_FLOOR = 8;
/** bcrypt reads 72 bytes; the cap exists so a form cannot post a megabyte. */
export const PASSWORD_MIN_LENGTH_CEILING = 128;
export const PASSWORD_MAX_LENGTH = 200;

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: PASSWORD_MIN_LENGTH_FLOOR,
  requireUpper: true,
  requireLower: true,
  requireDigit: false,
  requireSymbol: false,
};

/** The setting keys the policy is built from, as stored (strings). */
export interface PasswordPolicySettings {
  passwordMinLength?: string;
  passwordRequireUpper?: string;
  passwordRequireLower?: string;
  passwordRequireDigit?: string;
  passwordRequireSymbol?: string;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

/**
 * Settings → policy. Anything unparseable falls back to the default for that
 * field, and the minimum length is clamped into [floor, ceiling]: a stored '3'
 * (or a hand-edited row) can never make the rule weaker than the code default.
 */
export function parsePasswordPolicy(settings: PasswordPolicySettings): PasswordPolicy {
  const raw = Number.parseInt(settings.passwordMinLength ?? '', 10);
  const minLength = Number.isFinite(raw)
    ? Math.min(PASSWORD_MIN_LENGTH_CEILING, Math.max(PASSWORD_MIN_LENGTH_FLOOR, raw))
    : DEFAULT_PASSWORD_POLICY.minLength;
  return {
    minLength,
    requireUpper: bool(settings.passwordRequireUpper, DEFAULT_PASSWORD_POLICY.requireUpper),
    requireLower: bool(settings.passwordRequireLower, DEFAULT_PASSWORD_POLICY.requireLower),
    requireDigit: bool(settings.passwordRequireDigit, DEFAULT_PASSWORD_POLICY.requireDigit),
    requireSymbol: bool(settings.passwordRequireSymbol, DEFAULT_PASSWORD_POLICY.requireSymbol),
  };
}

/** Is a proposed minimum length one the settings route may store? */
export function isStorableMinLength(value: string): boolean {
  if (!/^\d{1,3}$/.test(value)) return false;
  const n = Number(value);
  return n >= PASSWORD_MIN_LENGTH_FLOOR && n <= PASSWORD_MIN_LENGTH_CEILING;
}

export type PasswordRuleId = 'min_length' | 'upper' | 'lower' | 'digit' | 'symbol';

/** The rules a policy actually imposes, in display order. */
export function passwordRules(policy: PasswordPolicy): PasswordRuleId[] {
  const rules: PasswordRuleId[] = ['min_length'];
  if (policy.requireUpper) rules.push('upper');
  if (policy.requireLower) rules.push('lower');
  if (policy.requireDigit) rules.push('digit');
  if (policy.requireSymbol) rules.push('symbol');
  return rules;
}

// Letters and digits are Unicode-aware on purpose: "Şifre" has an upper-case
// letter, and a policy that only counted A–Z would tell a Turkish or German user
// their password has none. A symbol is anything that is neither a letter, a
// digit nor whitespace.
const UPPER = /\p{Lu}/u;
const LOWER = /\p{Ll}/u;
const DIGIT = /\p{Nd}/u;
const SYMBOL = /[^\p{L}\p{Nd}\s]/u;

/** The rules `password` fails, in display order. Empty means it satisfies the policy. */
export function failedPasswordRules(password: string, policy: PasswordPolicy): PasswordRuleId[] {
  const failed: PasswordRuleId[] = [];
  if ([...password].length < policy.minLength) failed.push('min_length');
  if (policy.requireUpper && !UPPER.test(password)) failed.push('upper');
  if (policy.requireLower && !LOWER.test(password)) failed.push('lower');
  if (policy.requireDigit && !DIGIT.test(password)) failed.push('digit');
  if (policy.requireSymbol && !SYMBOL.test(password)) failed.push('symbol');
  return failed;
}

/**
 * Rule → the English sentence the API answers with. The browser shows the
 * localized text from the `passwordPolicy` dictionary block keyed by the same
 * ids; this is the fallback a non-browser client reads.
 */
export function describePasswordRule(rule: PasswordRuleId, policy: PasswordPolicy): string {
  switch (rule) {
    case 'min_length':
      return `Password must be at least ${policy.minLength} characters`;
    case 'upper':
      return 'Password must include an uppercase letter';
    case 'lower':
      return 'Password must include a lowercase letter';
    case 'digit':
      return 'Password must include a digit';
    case 'symbol':
      return 'Password must include a symbol';
  }
}

// ── Have I Been Pwned, k-anonymity range API ────────────────────────────────
//
// The whole privacy argument of the lookup is in these two functions: only the
// first five hex characters of the SHA-1 leave the box, and the match against
// the returned suffixes happens locally.

export const HIBP_PREFIX_LENGTH = 5;

/** Split an upper-case SHA-1 hex digest into the 5-char prefix we send and the 35-char suffix we keep. */
export function splitSha1(hexUpper: string): { prefix: string; suffix: string } {
  if (!/^[0-9A-F]{40}$/.test(hexUpper)) throw new Error('splitSha1 expects a 40-character upper-case hex SHA-1');
  return { prefix: hexUpper.slice(0, HIBP_PREFIX_LENGTH), suffix: hexUpper.slice(HIBP_PREFIX_LENGTH) };
}

/**
 * The range body is `SUFFIX:COUNT` lines (CRLF or LF). With `Add-Padding: true`
 * the API also returns padding lines with a count of 0, which are not breaches.
 * Returns how many times the password was seen, 0 when it was not.
 */
export function matchHibpRange(body: string, suffix: string): number {
  const want = suffix.toUpperCase();
  for (const line of body.split(/\r?\n/)) {
    const sep = line.indexOf(':');
    if (sep < 0) continue;
    if (line.slice(0, sep).trim().toUpperCase() !== want) continue;
    const count = Number.parseInt(line.slice(sep + 1).trim(), 10);
    return Number.isFinite(count) && count > 0 ? count : 0;
  }
  return 0;
}
