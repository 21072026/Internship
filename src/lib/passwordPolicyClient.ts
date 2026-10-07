'use client';

import { useEffect, useState } from 'react';
import {
  DEFAULT_PASSWORD_POLICY,
  failedPasswordRules,
  passwordRules,
  type PasswordPolicy,
  type PasswordRuleId,
} from '@/lib/passwordPolicyRule';

// The browser half of the password policy (#1544): fetch the resolved rules
// from GET /api/auth/password-policy once, and validate with the SAME pure rule
// the server applies (passwordPolicyRule.ts), so the form never accepts what
// the API refuses — the #1215 symptom. Until the fetch answers (or if it
// fails) the code default applies, which is also the server's default.

export interface ClientPasswordPolicy {
  policy: PasswordPolicy;
  rules: PasswordRuleId[];
  breachCheck: boolean;
  /** False until the server has answered; the default policy is in effect meanwhile. */
  loaded: boolean;
}

const FALLBACK: ClientPasswordPolicy = {
  policy: DEFAULT_PASSWORD_POLICY,
  rules: passwordRules(DEFAULT_PASSWORD_POLICY),
  breachCheck: false,
  loaded: false,
};

/** `token` is the invitation token on /auth/register, which decides the account's org. */
export function usePasswordPolicy(token?: string | null): ClientPasswordPolicy {
  const [state, setState] = useState<ClientPasswordPolicy>(FALLBACK);
  useEffect(() => {
    let cancelled = false;
    const qs = token ? `?token=${encodeURIComponent(token)}` : '';
    fetch(`/api/auth/password-policy${qs}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d?.policy) return;
        setState({ policy: d.policy, rules: d.rules ?? passwordRules(d.policy), breachCheck: Boolean(d.breachCheck), loaded: true });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [token]);
  return state;
}

/** The `passwordPolicy` dictionary block, as the components receive it. */
export interface PasswordPolicyDict {
  intro: string;
  rule_min_length: string;
  rule_upper: string;
  rule_lower: string;
  rule_digit: string;
  rule_symbol: string;
  breachCheckNote: string;
  breached: string;
  failed: string;
}

/** The localized clause for one rule ("be at least 12 characters"). */
export function passwordRuleText(rule: PasswordRuleId, policy: PasswordPolicy, dict: PasswordPolicyDict): string {
  const key = `rule_${rule}` as const;
  return dict[key].replace('{n}', String(policy.minLength));
}

/** The localized sentence for the first failed rule, or null when the password passes. */
export function passwordPolicyError(password: string, policy: PasswordPolicy, dict: PasswordPolicyDict): string | null {
  const failed = failedPasswordRules(password, policy);
  if (failed.length === 0) return null;
  return dict.failed.replace('{rules}', failed.map((r) => passwordRuleText(r, policy, dict)).join(', '));
}

/**
 * A refused password from the API (`{ code: 'password_policy' | 'password_breached', failed? }`)
 * rendered in the user's language; null when the body is not a password refusal.
 */
export function passwordRefusalText(
  body: { code?: string; failed?: string[] } | null | undefined,
  policy: PasswordPolicy,
  dict: PasswordPolicyDict,
): string | null {
  if (!body?.code) return null;
  if (body.code === 'password_breached') return dict.breached;
  if (body.code === 'password_policy') {
    const failed = (body.failed ?? []).filter((r): r is PasswordRuleId => ['min_length', 'upper', 'lower', 'digit', 'symbol'].includes(r));
    if (failed.length === 0) return dict.failed.replace('{rules}', passwordRuleText('min_length', policy, dict));
    return dict.failed.replace('{rules}', failed.map((r) => passwordRuleText(r, policy, dict)).join(', '));
  }
  return null;
}
