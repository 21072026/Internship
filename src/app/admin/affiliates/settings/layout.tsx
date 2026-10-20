import { notFound } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { shellCapabilities } from '@/lib/shellCapabilities';

// Closed for an organisation without the affiliate module (docs/affiliate-module.md).
// Not in the sidebar, so the gate is checked here rather than by gatePage().
export default async function AffiliateSettingsLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session) return notFound();
  const caps = await shellCapabilities(session.user.orgId);
  if (!caps.includes('affiliate')) notFound();
  return <>{children}</>;
}
