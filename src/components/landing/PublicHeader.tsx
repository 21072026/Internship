'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { GraduationCap, Github, Menu, X } from 'lucide-react';
import { BetaBadge } from '@/components/BetaBadge';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useT, useLocale } from '@/i18n/client';
import { GITHUB_URL } from './links';

/**
 * The one header every public page wears (#1197).
 *
 * Before this, each public page carried its own: the landing had the full nav,
 * /features an icon strip, /for-companies a third variant and the legal pages
 * none at all — so the chrome changed under the visitor as they moved through
 * the site, and half the pages offered no way back other than the browser.
 *
 * Two things are deliberate:
 *   - the wordmark is *always* a link to `/`, including on `/` itself. It is
 *     the control people reach for first, and having it be inert on the home
 *     page (as it was) teaches them it is not a link anywhere;
 *   - below `lg` the nav collapses into a real disclosure menu rather than
 *     being hidden. The old header dropped "Features" and "For companies"
 *     under `sm:`/`md:`, which left phone visitors with no route to them.
 *
 * A client component on purpose: the menu needs state, and `/apply-as-mentor`
 * mounts the same chrome. Its strings live in the `publicNav` namespace, which
 * — unlike `landing` — is shipped to the browser.
 */
export function PublicHeader({ showRegister = true }: { showRegister?: boolean }) {
  const t = useT();
  const locale = useLocale();
  const n = t.publicNav;
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Navigating with the menu open (or widening past the breakpoint that hides
  // the toggle) would otherwise leave an orphaned panel on screen.
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const mq = window.matchMedia('(min-width: 1024px)');
    const close = () => mq.matches && setOpen(false);
    mq.addEventListener('change', close);
    return () => mq.removeEventListener('change', close);
  }, [open]);

  const links = [
    { href: '/features', label: n.features },
    { href: '/for-companies', label: n.forCompanies },
    { href: '/projects', label: n.showcase },
  ];

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <header
      data-testid="public-header"
      className="sticky top-0 z-30 border-b border-gray-200 bg-white/85 backdrop-blur-sm dark:border-gray-800 dark:bg-gray-900/85"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="h-16 flex items-center justify-between gap-2">
          <Link
            href="/"
            data-testid="public-home-link"
            aria-label={n.homeLink}
            className="flex items-center gap-2 min-w-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            <GraduationCap className="h-7 w-7 text-blue-600 flex-shrink-0" />
            <span className="text-lg font-bold text-gray-900 dark:text-gray-100 truncate">InternshipCRM</span>
            <BetaBadge className="flex-shrink-0" />
          </Link>

          <nav aria-label={n.menu} className="hidden lg:flex items-center gap-6">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                aria-current={isActive(l.href) ? 'page' : undefined}
                className={`text-sm font-medium whitespace-nowrap transition-colors ${
                  isActive(l.href)
                    ? 'text-blue-600 dark:text-blue-400'
                    : 'text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white'
                }`}
              >
                {l.label}
              </Link>
            ))}
          </nav>

          <div className="flex items-center gap-2 flex-shrink-0">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              aria-label={n.github}
              className="hidden lg:inline-flex text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white transition-colors"
            >
              <Github className="h-5 w-5" />
            </a>
            {/* Language and theme live in the menu below `lg`: the theme toggle
                carries a text label, and keeping it in the bar squeezed the
                wordmark into an ellipsis on a 375px screen. */}
            <div className="hidden lg:flex items-center gap-2">
              <LanguageSwitcher current={locale} />
              <ThemeToggle />
            </div>
            <Link
              href="/auth/signin"
              className="hidden lg:inline text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white whitespace-nowrap transition-colors"
            >
              {n.signIn}
            </Link>
            {showRegister && (
              <Link
                href="/auth/register"
                className="hidden lg:inline bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 whitespace-nowrap transition-colors"
              >
                {n.register}
              </Link>
            )}

            <button
              type="button"
              data-testid="public-nav-toggle"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-controls="public-nav-mobile"
              aria-label={open ? n.closeMenu : n.openMenu}
              className="lg:hidden inline-flex items-center justify-center h-10 w-10 rounded-lg text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800 transition-colors"
            >
              {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>
      </div>

      {open && (
        <div
          id="public-nav-mobile"
          data-testid="public-nav-mobile"
          className="lg:hidden border-t border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900"
        >
          <nav aria-label={n.menu} className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex flex-col">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                aria-current={isActive(l.href) ? 'page' : undefined}
                className={`py-2.5 text-sm font-medium ${
                  isActive(l.href) ? 'text-blue-600 dark:text-blue-400' : 'text-gray-700 dark:text-gray-200'
                }`}
              >
                {l.label}
              </Link>
            ))}
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="py-2.5 text-sm font-medium text-gray-700 dark:text-gray-200"
            >
              {n.github}
            </a>
            <div className="mt-2 pt-3 border-t border-gray-100 dark:border-gray-800 flex flex-wrap items-center gap-3">
              <Link
                href="/auth/signin"
                className="text-sm font-medium text-gray-700 dark:text-gray-200"
              >
                {n.signIn}
              </Link>
              {showRegister && (
                <Link
                  href="/auth/register"
                  className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
                >
                  {n.register}
                </Link>
              )}
              <span className="ml-auto flex items-center gap-2">
                <LanguageSwitcher current={locale} />
                <ThemeToggle />
              </span>
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
