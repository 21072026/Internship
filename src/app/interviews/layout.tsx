import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { roleHome } from '@/lib/roleHome';
import { RoleShell } from '@/components/RoleShell';
import { I18nScope } from '@/i18n/scope';
import { gatePage } from '@/lib/pageCapabilityGate';

async function InterviewsLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/auth/signin');
  if (session.user.role !== 'ADMIN' && session.user.role !== 'MENTOR') redirect(roleHome(session.user.role));
  // Interview panels are the placement module (navLinks tags /interviews
  // `placements`; every /api/interview-panels route already asks for it). A
  // MARKETING org has none, so the URL answers 404 like its hidden nav link (MKT-6a).
  await gatePage('/interviews');

  return <RoleShell>{children}</RoleShell>;
}

// The segment's dictionary namespaces wrap the WHOLE layout, its own chrome
// included (#2987, src/i18n/scope.tsx).
export default function ScopedInterviewsLayout({ children }: { children: React.ReactNode }) {
  return (
    <I18nScope scope="interviews">
      <InterviewsLayout>{children}</InterviewsLayout>
    </I18nScope>
  );
}
