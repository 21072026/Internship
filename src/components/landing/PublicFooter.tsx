import Link from 'next/link';
import { GraduationCap } from 'lucide-react';
import { getServerDictionary } from '@/i18n/server';
import { VersionFooter } from '@/components/VersionFooter';
import { APP_VERSION } from '@/lib/version';
import { GITHUB_URL } from './links';

/**
 * The one footer every public page wears (#1197). Only the landing had one
 * before, so the legal pages — the pages a visitor is most likely to arrive on
 * from a search result — were dead ends.
 *
 * A server component: it holds no state, and keeping it off the client means
 * `package.json` (via APP_VERSION) stays out of the browser bundle. The three
 * legal labels are read from the namespaces that title those pages, so a link
 * here can never disagree with the heading it leads to.
 */
export async function PublicFooter() {
  const { t } = await getServerDictionary();
  const n = t.publicNav;

  const columns = [
    {
      title: n.colProduct,
      links: [
        { href: '/features', label: n.features },
        { href: '/for-companies', label: n.forCompanies },
        { href: '/projects', label: n.showcase },
        { href: '/release-notes', label: n.whatsNew },
      ],
    },
    {
      title: n.colCommunity,
      links: [
        { href: '/apply-as-mentor', label: n.becomeMentor },
        { href: GITHUB_URL, label: n.github, external: true },
        { href: '/code-of-conduct', label: t.codeOfConduct.title },
      ],
    },
    {
      title: n.colLegal,
      links: [
        { href: '/privacy', label: t.privacy.title },
        { href: '/terms', label: t.terms.title },
      ],
    },
  ];

  return (
    <footer
      data-testid="public-footer"
      className="border-t border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <div className="grid grid-cols-2 gap-8 sm:grid-cols-4">
          <div className="col-span-2 sm:col-span-1">
            <Link href="/" className="flex items-center gap-2 min-w-0">
              <GraduationCap className="h-6 w-6 text-blue-600 flex-shrink-0" />
              <span className="font-bold text-gray-900 dark:text-gray-100 truncate">InternshipCRM</span>
            </Link>
            <p className="mt-3 text-sm text-gray-500 dark:text-gray-400 leading-relaxed">{n.tagline}</p>
          </div>

          {columns.map((col) => (
            <div key={col.title}>
              {/* gray-500/400 rather than 400/500: the lighter pair fails
                  contrast on the dark surface at this size. */}
              <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                {col.title}
              </h2>
              <ul className="mt-3 space-y-2">
                {col.links.map((l) => (
                  <li key={l.href}>
                    {'external' in l && l.external ? (
                      <a
                        href={l.href}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white transition-colors"
                      >
                        {l.label}
                      </a>
                    ) : (
                      <Link
                        href={l.href}
                        className="text-sm text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white transition-colors"
                      >
                        {l.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-10 pt-6 border-t border-gray-100 dark:border-gray-800 flex flex-col sm:flex-row items-center justify-between gap-3 text-sm text-gray-500 dark:text-gray-400">
          <p>© {new Date().getFullYear()} InternshipCRM. {n.rights}</p>
          <VersionFooter version={APP_VERSION} />
        </div>
      </div>
    </footer>
  );
}
