'use client';

import { useEffect, useState } from 'react';
import { Share2 } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { useT } from '@/i18n/client';

interface SourceRow {
  id: string;
  name: string;
  mentees: number;
  inPipeline: number;
  hired: number;
  conversionToHired: number;
}

// Premium source-conversion report (Faz 2, #539) on the admin analytics page.
// Silent when locked — the CohortComparison card already renders the premium
// teaser for the whole tier, so we don't repeat it.
export function SourceConversion() {
  const t = useT();
  const c = t.analytics;
  const [rows, setRows] = useState<SourceRow[] | null>(null);
  const [unsourced, setUnsourced] = useState(0);

  useEffect(() => {
    fetch('/api/admin/analytics/sources')
      .then(async (r) => {
        if (!r.ok) return; // locked or error → the tier teaser handles messaging
        const d = await r.json();
        setRows(d.sources ?? []);
        setUnsourced(d.unsourced ?? 0);
      })
      .catch(() => {});
  }, []);

  if (!rows) return null;

  return (
    <Card className="mt-6" data-testid="source-conversion">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Share2 className="h-5 w-5 text-blue-600" />
          <CardTitle>{c.sourceConversionTitle}</CardTitle>
        </div>
      </CardHeader>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-400 py-4">{c.sourceConversionEmpty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800">
                <th className="py-2 pr-3">{c.sourceName}</th>
                <th className="py-2 pr-3">{c.cohortTotal}</th>
                <th className="py-2 pr-3">{c.sourceInPipeline}</th>
                <th className="py-2 pr-3">{c.cohortHired}</th>
                <th className="py-2">{c.cohortConversion}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="py-2 pr-3 font-medium text-gray-900 dark:text-gray-100">{r.name}</td>
                  <td className="py-2 pr-3">{r.mentees}</td>
                  <td className="py-2 pr-3">{r.inPipeline}</td>
                  <td className="py-2 pr-3">{r.hired}</td>
                  <td className="py-2">{r.conversionToHired}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {unsourced > 0 && (
        <p className="text-xs text-gray-400 mt-3">{c.sourceUnsourced.replace('{n}', String(unsourced))}</p>
      )}
    </Card>
  );
}
