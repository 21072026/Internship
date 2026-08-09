import { PublicHeader } from './PublicHeader';
import { PublicFooter } from './PublicFooter';

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
export function PublicShell({
  children,
  showRegister = true,
}: {
  children: React.ReactNode;
  showRegister?: boolean;
}) {
  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-blue-50 via-white to-indigo-50 dark:from-gray-950 dark:via-gray-900 dark:to-gray-950">
      <PublicHeader showRegister={showRegister} />
      <main id="main-content" className="flex-1">
        {children}
      </main>
      <PublicFooter />
    </div>
  );
}
