'use client';

import { Check, Circle } from 'lucide-react';
import { useT } from '@/i18n/client';
import { failedPasswordRules, type PasswordPolicy, type PasswordRuleId } from '@/lib/passwordPolicyRule';
import { passwordRuleText } from '@/lib/passwordPolicyClient';

// The rule list under a new-password field (#1544): every rule the org's
// policy imposes, ticked as the typed value satisfies it. Pure presentation —
// the check is passwordPolicyRule.ts, the same function the server runs.
export function PasswordRules({
  policy,
  rules,
  value,
  breachCheck,
}: {
  policy: PasswordPolicy;
  rules: PasswordRuleId[];
  value: string;
  breachCheck?: boolean;
}) {
  const t = useT();
  const failed = new Set(failedPasswordRules(value, policy));
  return (
    <div className="-mt-2 text-xs text-gray-500 dark:text-gray-400" data-testid="password-rules">
      <p>{t.passwordPolicy.intro}:</p>
      <ul className="mt-0.5 space-y-0.5">
        {rules.map((rule) => {
          const ok = value.length > 0 && !failed.has(rule);
          return (
            <li key={rule} className="flex items-center gap-1.5" data-testid={`password-rule-${rule}`} data-satisfied={ok ? '1' : '0'}>
              {ok ? (
                <Check className="h-3 w-3 shrink-0 text-green-600 dark:text-green-400" aria-hidden="true" />
              ) : (
                <Circle className="h-3 w-3 shrink-0 text-gray-300 dark:text-gray-600" aria-hidden="true" />
              )}
              <span className={ok ? 'text-green-700 dark:text-green-400' : undefined}>{passwordRuleText(rule, policy, t.passwordPolicy)}</span>
            </li>
          );
        })}
      </ul>
      {breachCheck && <p className="mt-0.5">{t.passwordPolicy.breachCheckNote}</p>}
    </div>
  );
}
