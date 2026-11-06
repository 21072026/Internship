import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getServerDictionary } from '@/i18n/server';
import { roleHome } from '@/lib/roleHome';
import { is2faRequiredFor } from '@/lib/twoFactorPolicy';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { resolveCustomStages } from '@/lib/pipelineStages';
import { resolveCustomCriteria } from '@/lib/evaluationTemplates';
import { PipelineStagesProvider } from '@/lib/pipelineStagesClient';
import { EvaluationCriteriaProvider } from '@/lib/evaluationCriteriaClient';
import MentorDashboard from '@/app/mentor/page';
import PortalDashboard from '@/app/portal/page';

// The role home inside the Teams tab (#1954). The SAME page components the
// mentor and mentee shells render (no fork), inside the providers their
// layouts give them, without the shell's chrome.
//
// The shells' 2FA policy gate (#1644) holds here too, before anything is
// rendered: a person the org requires to enrol is sent to the browser to do
// it — /security-setup is not framable, and enrolment needs a scanner anyway.
// Every other role, and a vertical without the mentorship module, gets the
// way to their home in the browser rather than a second copy of that shell.
export const dynamic = 'force-dynamic';

function OpenInBrowser({ title, body, href, cta }: { title: string; body: string; href: string; cta: string }) {
  return (
    <main className="mx-auto max-w-lg p-6 text-sm text-gray-800 dark:text-gray-100">
      <h1 className="mb-2 text-lg font-semibold">{title}</h1>
      <p className="mb-4">{body}</p>
      <a className="text-blue-600 underline" href={href} target="_blank" rel="noopener noreferrer">{cta}</a>
    </main>
  );
}

export default async function EmbedHome() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect('/embed');
  const t = (await getServerDictionary()).t.embed;

  const me = await prisma.user.findUnique({ where: { id: session.user.id }, select: { twoFactorEnabled: true } });
  if (!session.user.impersonatorId && !me?.twoFactorEnabled && (await is2faRequiredFor(session.user.role, await settingsOrgOf(session)))) {
    return <OpenInBrowser title={t.twoFactorTitle} body={t.twoFactorBody} href="/security-setup" cta={t.openApp} />;
  }

  const capabilities = await shellCapabilities(session.user.orgId);
  const role = session.user.role;
  if (!capabilities.includes('mentorship') || (role !== 'MENTOR' && role !== 'MENTEE')) {
    return <OpenInBrowser title={t.signedInTitle} body={t.signedInAs.replace('{name}', session.user.name ?? session.user.email ?? '')} href={roleHome(role)} cta={t.openApp} />;
  }

  const [stages, criteria] = await Promise.all([resolveCustomStages(session.user.orgId), resolveCustomCriteria(session.user.orgId)]);
  return (
    <main className="mx-auto max-w-5xl p-4" data-testid="embed-home">
      <PipelineStagesProvider stages={stages}>
        <EvaluationCriteriaProvider criteria={criteria}>
          {role === 'MENTOR' ? <MentorDashboard /> : <PortalDashboard searchParams={Promise.resolve({})} />}
        </EvaluationCriteriaProvider>
      </PipelineStagesProvider>
    </main>
  );
}
