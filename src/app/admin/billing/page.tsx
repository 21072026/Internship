'use client';

import { useState, type ComponentType } from 'react';
import { useT } from '@/i18n/client';
import { BillingPlanTab } from '@/components/billing/BillingPlanTab';
import { BillingFeaturesTab } from '@/components/billing/BillingFeaturesTab';
import { OrgBillingProvider } from '@/components/billing/OrgBillingContext';

// The tenant's own bill (#1739). A TABBED SHELL on purpose: the plan / meter /
// history tab is the first, #1734 added the included-features tab, and #1763
// adds the usage tab here. Adding a tab is one entry in TABS plus one
// component; nothing else in this file changes. The bill itself
// (GET /api/org/billing, which takes no orgId and answers only for the
// caller's own organisation) is fetched ONCE, by OrgBillingProvider, and every
// tab reads it from there — a tab with data of its own fetches that itself.

type TabKey = 'plan' | 'features';

const TABS: { key: TabKey; Component: ComponentType }[] = [
  { key: 'plan', Component: BillingPlanTab },
  { key: 'features', Component: BillingFeaturesTab },
];

export default function AdminBillingPage() {
  const t = useT();
  const [tab, setTab] = useState<TabKey>('plan');
  const Active = (TABS.find((x) => x.key === tab) ?? TABS[0]).Component;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.billing.title}</h1>
        <p className="text-gray-500 dark:text-gray-400 mt-1">{t.billing.subtitle}</p>
      </div>

      <div className="mb-4 flex gap-1 rounded-lg bg-gray-100 dark:bg-gray-800 p-1 max-w-xl" role="tablist" aria-label={t.billing.title}>
        {TABS.map(({ key }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            data-testid={`billing-tab-${key}`}
            className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition ${
              tab === key ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-900 dark:text-gray-100' : 'text-gray-600 dark:text-gray-300'
            }`}
          >
            {t.billing.tabs[key]}
          </button>
        ))}
      </div>

      <OrgBillingProvider>
        <div role="tabpanel" data-testid={`billing-panel-${tab}`}>
          <Active />
        </div>
      </OrgBillingProvider>
    </div>
  );
}
