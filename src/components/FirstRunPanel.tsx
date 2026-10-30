import Link from 'next/link';
import { UserPlus, Users, Link2, CheckCircle } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import type { Dictionary } from '@/i18n/dictionaries';

/**
 * The /admin first-run panel (#1751): a brand-new tenant sees three numbered
 * steps to its first pair instead of a dashboard of empty lists. The admin page
 * mounts it while the org has no mentorship relation at all and the org's
 * product has `mentorship`; the first pairing makes it disappear.
 *
 * It READS nothing and WRITES nothing: three links to screens that exist, plus
 * the Community terms when the org is on that plan (`community` is passed in,
 * resolved from the price list by the page). The tenant's data — stages,
 * templates — comes from the starter pack (#2066), never from here.
 */
export function FirstRunPanel({
  t,
  community,
}: {
  t: Dictionary['firstRun'];
  community: { activePairs: number | null; adminSeats: number | null } | null;
}) {
  const steps = [
    { icon: UserPlus, title: t.step1Title, body: t.step1Body, href: '/admin/invite?role=MENTOR' },
    { icon: Users, title: t.step2Title, body: t.step2Body, href: '/admin/invite?role=MENTEE' },
    { icon: Link2, title: t.step3Title, body: t.step3Body, href: '/admin/mentorship' },
  ];
  return (
    <Card className="mb-8" data-testid="first-run-panel">
      <CardHeader>
        <CardTitle>{t.title}</CardTitle>
        <CardDescription>{t.subtitle}</CardDescription>
      </CardHeader>
      <ol className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {steps.map((step, i) => (
          <li key={step.href} className="flex flex-col rounded-xl border border-gray-200 dark:border-gray-700 p-4">
            <div className="flex items-center gap-3">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-600 text-sm font-semibold text-white" aria-hidden="true">
                {i + 1}
              </span>
              <step.icon className="h-5 w-5 text-blue-600" aria-hidden="true" />
            </div>
            <h3 className="mt-3 font-semibold text-gray-900 dark:text-gray-100">{step.title}</h3>
            <p className="mt-1 flex-1 text-sm text-gray-600 dark:text-gray-400">{step.body}</p>
            <Link href={step.href} data-testid={`first-run-step-${i + 1}`} className="mt-3 text-sm font-medium text-blue-600 hover:underline">
              {t.stepCta} →
            </Link>
          </li>
        ))}
      </ol>
      {community && (
        <div className="mt-6 border-t border-gray-100 dark:border-gray-800 pt-4" data-testid="first-run-community">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t.communityTitle}</h3>
          <ul className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-gray-600 dark:text-gray-400">
            {[
              community.activePairs != null ? t.communityPairs.replace('{pairs}', String(community.activePairs)) : null,
              community.adminSeats != null ? t.communityAdmins.replace('{admins}', String(community.adminSeats)) : null,
              t.communityFree,
            ]
              .filter((line): line is string => !!line)
              .map((line) => (
                <li key={line} className="flex items-center gap-1.5">
                  <CheckCircle className="h-4 w-4 text-green-600" aria-hidden="true" />
                  {line}
                </li>
              ))}
          </ul>
          <Link href="/pricing" className="mt-2 inline-block text-sm text-blue-600 hover:underline">{t.pricingLink}</Link>
        </div>
      )}
    </Card>
  );
}
