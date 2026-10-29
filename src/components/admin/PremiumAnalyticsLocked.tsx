'use client';

import Link from 'next/link';
import { UpgradePrompt } from '@/components/UpgradePrompt';
import { useT } from '@/i18n/client';
import type { PremiumFeature } from '@/lib/entitlementsCatalog';

// The one locked-state panel for the premium analytics tier (#1442).
//
// Cohort comparison, source conversion and the cross-program benchmark share a
// single gate, so they get a single explanation. Before this, the tier being
// off was announced twice (a locked card inside CohortComparison and another
// inside ProgramBenchmark) while source conversion said nothing at all — and
// each of those cards learned it was locked by reading a 403 of its own.
//
// Since #1745 the explanation is the shared upgrade prompt: the feature, the
// plan that includes it with its published price, and the request. The
// settings link stays for an installation that switches the tier on there.
export function PremiumAnalyticsLocked({ title, feature = 'ADVANCED_ANALYTICS' }: { title?: string; feature?: PremiumFeature }) {
  const t = useT();
  const c = t.analytics;
  return (
    <div className="mt-6 space-y-2" data-testid="premium-analytics-locked">
      {title && <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</p>}
      <UpgradePrompt gate={{ code: 'feature_locked', feature }} viewer="admin" />
      <Link href="/admin/settings" className="text-xs text-blue-600 dark:text-blue-400 hover:underline inline-block">
        {c.cohortCompareUnlockCta}
      </Link>
    </div>
  );
}
