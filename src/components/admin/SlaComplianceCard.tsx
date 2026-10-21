'use client';

// The stage-SLA compliance rate (#1723), shown on /admin/sla and
// /admin/analytics. Always numerator, denominator and period, and the
// definition printed under the number — never a bare percentage.

import { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { useT } from '@/i18n/client';
import { fillTemplate } from '@/components/ui/fillTemplate';

interface Compliance {
  met: number;
  total: number;
  rate: number | null;
  days: number;
  byStage: { stageKey: string; met: number; total: number }[];
}

export function SlaComplianceCard({ days = 90 }: { days?: number }) {
  const t = useT();
  const [data, setData] = useState<Compliance | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/admin/sla/compliance?days=${days}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => live && setData(body))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [days]);

  if (!data) return null;
  const S = t.slaQueue;
  return (
    <Card data-testid="sla-compliance">
      <CardHeader>
        <CardTitle>{S.complianceTitle}</CardTitle>
      </CardHeader>
      <p className="text-xs text-gray-500 mb-2">{fillTemplate(S.period, { n: String(data.days) })}</p>
      {data.total > 0 ? (
        <>
          <p className="text-3xl font-semibold" data-testid="sla-compliance-rate">
            {data.rate}%
          </p>
          <p className="text-sm text-gray-700 dark:text-gray-300" data-testid="sla-compliance-fraction">
            {fillTemplate(S.complianceValue, { met: String(data.met), total: String(data.total) })}
          </p>
        </>
      ) : (
        <p className="text-sm text-gray-600 dark:text-gray-400">{S.complianceNone}</p>
      )}
      <p className="mt-3 text-xs text-gray-500" data-testid="sla-compliance-definition">
        {S.complianceDefinition}
      </p>
    </Card>
  );
}
