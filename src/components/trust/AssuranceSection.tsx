import type { Locale } from '@/i18n/config';
import { ASSURANCE_HEADING, ASSURANCE_LINKS } from '@/lib/trustAssurance';

/**
 * The Trust Center's "Assurance" section (#2031).
 *
 * A server component with no state and no client JS: it renders the four
 * assurance documents plus the served `security.txt`, in the visitor's locale,
 * from the single typed list in `src/lib/trustAssurance.ts`.
 *
 * MOUNT POINT: the /trust page, built by the sibling task #2027. It is kept
 * standalone so the two tasks never edit the same file:
 *
 *     import { AssuranceSection } from '@/components/trust/AssuranceSection';
 *     …
 *     <AssuranceSection locale={locale} />   // locale from getServerDictionary()
 *
 * External links open in a new tab because they leave the app for GitHub;
 * `rel="noopener"` on every one of them, and the internal `security.txt` link
 * stays in-tab.
 */
export function AssuranceSection({ locale, className }: { locale: Locale; className?: string }) {
  const heading = ASSURANCE_HEADING[locale];

  return (
    <section className={className} data-testid="trust-assurance">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{heading.title}</h2>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{heading.intro}</p>

      <ul className="mt-4 space-y-3">
        {ASSURANCE_LINKS.map((link) => {
          const external = link.href.startsWith('http');
          return (
            <li key={link.key}>
              <a
                href={link.href}
                data-testid={`trust-assurance-${link.key}`}
                {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                className={`text-sm font-medium text-blue-700 hover:underline dark:text-blue-300 ${
                  link.monospace ? 'font-mono' : ''
                }`}
              >
                {link.label[locale]}
                {external ? ' ↗' : ''}
              </a>
              <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-300">{link.description[locale]}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
