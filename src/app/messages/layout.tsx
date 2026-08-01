import type { Viewport } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { roleHome } from '@/lib/roleHome';
import { MessagesShell } from '@/components/MessagesShell';

/**
 * Route-scoped viewport (#1009). `viewportFit: 'cover'` is what makes
 * `env(safe-area-inset-*)` report the real system-bar insets, which the
 * full-height chat frame subtracts so its bottom edge lands on the visible
 * bottom instead of behind the navigation bar. Scoped to /messages on purpose:
 * these are the only screens built to reserve the insets themselves.
 *
 * A nested export replaces the root one for these routes, so the root's fields
 * are repeated here rather than inherited.
 */
export const viewport: Viewport = {
  themeColor: '#1D4ED8',
  interactiveWidget: 'resizes-content',
  viewportFit: 'cover',
};

// Conversation threads are available to any authenticated participant.
// MessagesShell provides the mobile app shell (full-height frame + header with
// back/home) and the desktop document flow — see the comment in that file.
export default async function MessagesLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/auth/signin');

  return <MessagesShell homeHref={roleHome(session.user.role)}>{children}</MessagesShell>;
}
