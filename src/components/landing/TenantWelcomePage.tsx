import Link from 'next/link';
import { fillTemplate } from '@/components/ui/fillTemplate';
import { welcomeParagraphs } from '@/lib/tenantWelcomeRule';
import type { TenantWelcome } from '@/lib/tenantWelcome';

// The page `/` shows on a tenant's own domain when the org wrote a welcome
// (#1664): their logo, their headline, their words, and the two doors in. It
// replaces our marketing landing on that host only — none of our pitch, prices
// or links.
//
// PLAIN TEXT ONLY. `title` and `body` are tenant-written and this page is
// public: they are rendered as React text nodes (escaped), split into
// paragraphs by welcomeParagraphs(). Never dangerouslySetInnerHTML here.

const HEX = /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i;

export function TenantWelcomePage({
  welcome,
  copy,
}: {
  welcome: TenantWelcome;
  copy: { signIn: string; apply: string; poweredBy: string };
}) {
  const accent = welcome.color && HEX.test(welcome.color) ? welcome.color : null;
  const paragraphs = welcomeParagraphs(welcome.body);
  return (
    <main className="flex min-h-screen flex-col bg-white dark:bg-gray-950" data-testid="tenant-welcome">
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center px-4 py-16 sm:px-6">
        {welcome.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- an admin-supplied logo of any origin the write check allowed
          <img src={welcome.logoUrl} alt={welcome.brandName} className="mb-8 h-12 w-auto self-start object-contain" />
        ) : (
          <p className="mb-8 text-lg font-semibold text-gray-900 dark:text-gray-100">{welcome.brandName}</p>
        )}
        <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-gray-50 sm:text-4xl" data-testid="tenant-welcome-title">
          {welcome.title}
        </h1>
        {paragraphs.length > 0 && (
          <div className="mt-6 space-y-4 text-base leading-relaxed text-gray-700 dark:text-gray-300" data-testid="tenant-welcome-body">
            {paragraphs.map((lines, i) => (
              <p key={i}>
                {lines.map((line, j) => (
                  <span key={j}>
                    {j > 0 && <br />}
                    {line}
                  </span>
                ))}
              </p>
            ))}
          </div>
        )}
        <div className="mt-10 flex flex-wrap gap-3">
          <Link
            href="/auth/signin"
            data-testid="tenant-welcome-signin"
            className="inline-flex items-center rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"
            style={accent ? { backgroundColor: accent } : undefined}
          >
            {copy.signIn}
          </Link>
          {welcome.canApply && (
            <Link
              href="/apply"
              data-testid="tenant-welcome-apply"
              className="inline-flex items-center rounded-lg border border-gray-300 px-5 py-2.5 text-sm font-semibold text-gray-800 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-100 dark:hover:bg-gray-800"
            >
              {copy.apply}
            </Link>
          )}
        </div>
      </div>
      <footer className="py-6 text-center text-xs text-gray-500 dark:text-gray-400">{fillTemplate(copy.poweredBy, { product: welcome.product })}</footer>
    </main>
  );
}
