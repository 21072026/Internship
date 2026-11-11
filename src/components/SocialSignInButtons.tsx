'use client';

import { useT } from '@/i18n/client';

// "Continue with Google / Microsoft / LinkedIn" (#1962). The list comes from the
// server page (socialButtonsForHeaders): only providers the operator configured
// are ever drawn, so an unconfigured one is invisible rather than broken. Plain
// links: the login route answers with a redirect to the provider.
export function SocialSignInButtons({ providers }: { providers: { id: string; label: string }[] }) {
  const t = useT();
  if (providers.length === 0) return null;
  return (
    <div className="mt-6" data-testid="social-sign-in">
      <div className="mb-3 flex items-center gap-3 text-xs text-gray-400" aria-hidden="true">
        <span className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
        {t.auth.ssoTenantOr}
        <span className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
      </div>
      <div className="space-y-2">
        {providers.map((p) => (
          <a
            key={p.id}
            href={`/api/auth/social/${p.id}/login`}
            data-testid={`social-sign-in-${p.id}`}
            className="flex w-full items-center justify-center rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-800 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
          >
            {t.auth.socialContinue.replace('{provider}', p.label)}
          </a>
        ))}
      </div>
    </div>
  );
}
