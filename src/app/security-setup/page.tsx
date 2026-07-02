import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { is2faRequiredFor } from '@/lib/twoFactorPolicy';
import { TwoFactorSetupGate } from '@/components/TwoFactorSetupGate';

const HOME: Record<string, string> = { ADMIN: '/admin', MENTOR: '/mentor', MENTEE: '/portal', COMPANY: '/company', SOURCE: '/source' };

// The 2FA enforcement gate. Reached only when the org policy requires 2FA for
// the user's role and they haven't enabled it. Lives outside the role layouts so
// enforcing those layouts can redirect here without a loop.
export default async function SecuritySetupPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/auth/signin');

  const home = HOME[session.user.role] ?? '/';
  const me = await prisma.user.findUnique({ where: { id: session.user.id }, select: { twoFactorEnabled: true } });

  // Nothing to do here if 2FA isn't required for this role or it's already on.
  if (me?.twoFactorEnabled || !(await is2faRequiredFor(session.user.role))) {
    redirect(home);
  }

  return <TwoFactorSetupGate home={home} />;
}
