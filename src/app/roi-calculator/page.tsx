import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/pageMetadata';
import { getServerDictionary } from '@/i18n/server';
import { PublicShell } from '@/components/landing/PublicShell';
import { RoiCalculator } from '@/components/RoiCalculator';
import { requestVerticalHas, requireVerticalCapability } from '@/lib/verticalPage';

export async function generateMetadata(): Promise<Metadata> {
  if (!(await requestVerticalHas('mentorship'))) return {};
  return pageMetadata((t) => ({ title: t.roiCalculator.title, description: t.roiCalculator.subtitle }));
}

export const dynamic = 'force-dynamic';

// The public ROI calculator (#1755). Public, no account, no e-mail: the result
// is computed in the browser through the ONE model, computeRoi() in
// src/lib/roi.ts, so it cannot print a different number from the internal
// report (/admin/analytics/roi) for the same inputs. The cost side is our
// published price (src/lib/plans.ts). The internship product's page — it
// speaks of interns and mentees — so it answers 404 elsewhere.
export default async function RoiCalculatorPage() {
  await requireVerticalCapability('mentorship');
  const { t } = await getServerDictionary();
  const c = t.roiCalculator;
  return (
    <PublicShell breadcrumb={{ name: c.title, path: '/roi-calculator' }}>
      <div className="max-w-5xl mx-auto px-4 py-12 sm:py-16">
        <div className="text-center max-w-3xl mx-auto mb-10">
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 dark:text-gray-100">{c.title}</h1>
          <p className="mt-4 text-lg text-gray-600 dark:text-gray-300">{c.subtitle}</p>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{c.noSignup}</p>
        </div>
        <RoiCalculator />
      </div>
    </PublicShell>
  );
}
