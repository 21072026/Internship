'use client';

import { Lock } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { useT } from '@/i18n/client';
import { UpgradePrompt } from '@/components/UpgradePrompt';

// The one locked-state panel for the premium analytics tier (#1442).
//
// Cohort comparison, source conversion and the cross-program benchmark share a
// single gate, so they get a single explanation. Before this, the tier being
// off was announced twice (a locked card inside CohortComparison and another
// inside ProgramBenchmark) while source conversion said nothing at all — and
// each of those cards learned it was locked by reading a 403 of its own.
//
// A title, one sentence and the shared upgrade door: it is a state, not a
// sales page.
export function PremiumAnalyticsLocked({ title }: { title?: string }) {
  const t = useT();
  const c = t.analytics;
  return (
    <Card className="mt-6" data-testid="premium-analytics-locked">
      <div className="flex items-start gap-3">
        <Lock className="h-5 w-5 text-gray-400 mt-0.5 flex-shrink-0" />
        <div>
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title ?? c.premiumLockedTitle}</p>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{c.premiumLockedBody}</p>
          {/* The door (#1745): the plan that includes the tier, its published
              price and the upgrade request — not a link to a settings toggle
              that no longer exists (the tier is an entitlement since #1740). */}
          <UpgradePrompt gate={{ code: 'feature_locked', feature: 'ADVANCED_ANALYTICS' }} className="mt-3" />
        </div>
      </div>
    </Card>
  );
}
