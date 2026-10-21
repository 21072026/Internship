'use client';

import { useState, type ComponentType } from 'react';
import { useT } from '@/i18n/client';
import { BillingPlanTab } from '@/components/billing/BillingPlanTab';

// The tenant's own bill (#1739). A TABBED SHELL on purpose: the plan / meter /
// history tab is the first, and sibling tasks add theirs here — #1734 the
// included-features-and-overrides tab, #1763 the full usage tab. Adding a tab
// is one entry in TABS plus one component that loads its own data; nothing
// else in this file changes. Every number is the server's
// (GET /api/org/billing, which takes no orgId and answers only for the
// caller's own organisation).

type TabKey = 'plan';

const TABS: { key: TabKey; Component: ComponentType }[] = [{ key: 'plan', Component: BillingPlanTab }];

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

      <div role="tabpanel" data-testid={`billing-panel-${tab}`}>
        <Active />
      </div>
    </div>
  );
}
