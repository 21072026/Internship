import { NO_INDEX } from '@/lib/pageMetadata';
import type { Viewport } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { roleHome } from '@/lib/roleHome';
import { MessagesShell } from '@/components/MessagesShell';
import { RoleShell } from '@/components/RoleShell';
import { resolveRequestVertical } from '@/i18n/server';
import { themeColorFor } from '@/lib/accent';

// Signed-in area: never in a search result (#1376).
export const metadata = NO_INDEX;

/**
 * Route-scoped viewport (#1009). `viewportFit: 'cover'` is what makes
 * `env(safe-area-inset-*)` report the real system-bar insets, which the
 * full-height chat frame subtracts so its bottom edge lands on the visible
 * bottom instead of behind the navigation bar. Scoped to /messages on purpose:
 * these are the only screens built to reserve the insets themselves.
 *
 * A nested export replaces the root one for these routes, so the root's fields
 * are repeated here rather than inherited — including the vertical-aware tint
 * (#2492): a static '#1D4ED8' here painted a SaleVali install's status bar
 * internship blue on exactly the screen its manifest shortcut opens.
 */
export async function generateViewport(): Promise<Viewport> {
  const vertical = await resolveRequestVertical();
  return {
    themeColor: themeColorFor(vertical),
    interactiveWidget: 'resizes-content',
    viewportFit: 'cover',
  };
}

// Conversation threads are available to any authenticated participant.
// MessagesShell provides the mobile app shell (full-height frame + header with
// back/home) and the desktop document flow — see the comment in that file.
// RoleShell adds the role's sidebar (#2358), but on desktop only: below `lg` its
// top bar and padding sat around a frame sized to the whole viewport and pushed
// the chat 88px past the bottom of the screen (#2463). On a phone MessagesShell's
// own header is the way back out.
export default async function MessagesLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  // The callbackUrl is what makes the manifest's "Messages" shortcut (#2084)
  // land here after signing in, instead of on the role's home page.
  if (!session) redirect('/auth/signin?callbackUrl=/messages');

  return (
    <RoleShell mobileChrome={false}>
      <MessagesShell homeHref={roleHome(session.user.role)}>{children}</MessagesShell>
    </RoleShell>
  );
}
