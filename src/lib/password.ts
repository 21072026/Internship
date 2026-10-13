import { z } from 'zod';
import { NextResponse } from 'next/server';
import { getSettings } from '@/lib/settings';
import { settingsOrgOfRow } from '@/lib/settingsOrg';
import { lookupBreachedPassword } from '@/lib/breachedPassword';
import {
  DEFAULT_PASSWORD_POLICY,
  PASSWORD_MAX_LENGTH,
  describePasswordRule,
  failedPasswordRules,
  parsePasswordPolicy,
  passwordRules,
  type PasswordPolicy,
  type PasswordRuleId,
} from '@/lib/passwordPolicyRule';

// The password policy (#1544) — the server half. The rules themselves are
// DATA (five settings, read through the per-org chain) and the rule check is
// pure in passwordPolicyRule.ts, shared with the browser forms so the client
// renders exactly what the server enforces (#1215). This module is the ONE
// entry point every path that accepts a new password calls: register, reset,
// account. A new such path calls `checkPassword()`; it does not re-read the
// settings or re-implement a regex.
//
// `passwordSchema` is deliberately only the SHAPE (a non-empty string within
// the cap): the policy is resolved per org and asynchronously, so it cannot
// live in a module-scope zod schema. The route parses the body with the shape,
// resolves the org, then asks `checkPassword()`.

export const passwordSchema = z
  .string()
  .min(1, 'Password is required')
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`);

export interface ResolvedPasswordPolicy {
  policy: PasswordPolicy;
  /** The rules the policy imposes, in display order — what the forms list. */
  rules: PasswordRuleId[];
  /** Whether new passwords are screened against Have I Been Pwned. */
  breachCheck: boolean;
}

/** The policy an org's new passwords are judged by: its own rows → global → default. */
export async function resolvePasswordPolicy(orgId: string | null | undefined): Promise<ResolvedPasswordPolicy> {
  const settings = await getSettings(await settingsOrgOfRow(orgId));
  const policy = parsePasswordPolicy(settings);
  return { policy, rules: passwordRules(policy), breachCheck: settings.breachedPasswordCheck === 'true' };
}

export type PasswordVerdict =
  | { ok: true }
  | { ok: false; code: 'password_policy'; failed: PasswordRuleId[]; message: string }
  | { ok: false; code: 'password_breached'; message: string };

export const BREACHED_PASSWORD_MESSAGE =
  'This password has appeared in a known data breach. Choose a different one.';

/**
 * Judge a candidate password for an account in `orgId`: the org's policy
 * first, then — when the org has the screening on — the breach lookup, which
 * fails OPEN (an outage never refuses a password; breachedPassword.ts).
 */
export async function checkPassword(password: string, orgId: string | null | undefined): Promise<PasswordVerdict> {
  const { policy, breachCheck } = await resolvePasswordPolicy(orgId);
  const failed = failedPasswordRules(password, policy);
  if (failed.length > 0) {
    return { ok: false, code: 'password_policy', failed, message: describePasswordRule(failed[0], policy) };
  }
  if (breachCheck) {
    const lookup = await lookupBreachedPassword(password);
    if (lookup.checked && lookup.breached) {
      return { ok: false, code: 'password_breached', message: BREACHED_PASSWORD_MESSAGE };
    }
  }
  return { ok: true };
}

/** The 400 a route answers with for a refused password: the message, the code and the failed rules. */
export function passwordRefusal(verdict: Exclude<PasswordVerdict, { ok: true }>): NextResponse {
  return NextResponse.json(
    { error: verdict.message, code: verdict.code, ...(verdict.code === 'password_policy' ? { failed: verdict.failed } : {}) },
    { status: 400 },
  );
}

/**
 * Policy-only, synchronous check against an explicit policy (the code default
 * when none is given). Kept for callers that cannot await the settings; the
 * routes use `checkPassword()`.
 */
export function validatePassword(pw: string, policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY): string | null {
  const failed = failedPasswordRules(pw, policy);
  return failed.length ? describePasswordRule(failed[0], policy) : null;
}
