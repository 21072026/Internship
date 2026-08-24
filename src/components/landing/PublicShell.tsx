import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { hasSessionCookie } from '@/lib/sessionCookie';
import { roleHome } from '@/lib/roleHome';
import { PublicHeader } from './PublicHeader';
import { PublicFooter } from './PublicFooter';
import { AnalyticsScripts } from '@/components/AnalyticsScripts';

/**
 * Frame for every public page (#1197): same header, same background, same
 * footer, everywhere.
 *
 * It also supplies `#main-content` — the target of the skip-to-content link the
 * root layout renders. Only the signed-in shell had that anchor, so on every
 * public page the first thing a keyboard or screen-reader user hit was a link
 * that went nowhere.
 *
 * The footer is pinned below the fold on short pages (`flex-1` on main) so the
 * legal pages don't end in a strip of chrome halfway up the screen.
 *
 * `showRegister={false}` for the company path: companies have no self-service
 * sign-up (#1102/#1104), so a "Register" button there would send them into the
 * mentee flow. Everything else about the chrome stays identical.
 */
export async function PublicShell({
  children,
  showRegister = true,
}: {
  children: React.ReactNode;
  showRegister?: boolean;
}) {
  // These pages are public but not only for the public (#1203): a signed-in user
  // reaches /release-notes from the sidebar version footer, and /privacy or
  // /terms from a consent screen. Showing them "Sign In / Register" told them
  // they had been logged out. Resolved here, on the server, so the header is
  // right in the first byte — a client-side useSession() would render the
  // signed-out chrome first and swap it a moment later, which looks like the
  // very bug it would be fixing.
  const session = (await hasSessionCookie()) ? await getServerSession(authOptions) : null;
  const dashboardHref = session ? roleHome(session.user.role) : undefined;

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-blue-50 via-white to-indigo-50 dark:from-gray-950 dark:via-gray-900 dark:to-gray-950">
      <PublicHeader showRegister={showRegister} dashboardHref={dashboardHref} />
      <main id="main-content" className="flex-1">
        {children}
      </main>
      <PublicFooter />
      {/* Public pages only (#1242) — never the signed-in CRM, where a pageview
          would carry a mentee's name in the URL to a third party. */}
      <AnalyticsScripts />
    </div>
  );
}
