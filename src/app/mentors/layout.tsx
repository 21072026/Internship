import { NO_INDEX } from '@/lib/pageMetadata';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { roleHome } from '@/lib/roleHome';
import { RoleShell } from '@/components/RoleShell';
import { gatePage } from '@/lib/pageCapabilityGate';
import { I18nScope } from '@/i18n/scope';

// Signed-in area: never in a search result (#1376).
export const metadata = NO_INDEX;

async function MentorsLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/auth/signin');
  // An allowlist: the mentor directory is for the mentoring roles only. A role
  // added later (AFFILIATE, #3115) is sent home instead of falling through.
  if (!['ADMIN', 'MENTOR', 'MENTEE'].includes(session.user.role)) {
    redirect(roleHome(session.user.role));
  }
  // Choosing a mentor is the `mentorship` module (src/lib/pageCapabilityGate.ts):
  // a vertical without it has no directory, so the URL answers 404.
  await gatePage('/mentors');

  return <RoleShell>{children}</RoleShell>;
}

// The segment's dictionary namespaces wrap the WHOLE layout, its own chrome
// included (#2987, src/i18n/scope.tsx).
export default function ScopedMentorsLayout({ children }: { children: React.ReactNode }) {
  return (
    <I18nScope scope="mentors">
      <MentorsLayout>{children}</MentorsLayout>
    </I18nScope>
  );
}
