'use client';

import { useState } from 'react';
import { useT } from '@/i18n/client';

// "Share the screenshot with the feedback review" (#3936), under a report's
// screenshot on the admin's report page. The review reads a screenshot only
// while this is on (API scope `support:read_shared_screenshots`); turning it off
// takes it back. PUT /api/admin/support/reports/[id]/screenshot-share.
export function SupportReportScreenshotShare({ reportId, initial }: { reportId: string; initial: boolean }) {
  const t = useT();
  const a = t.adminReports;
  const [shared, setShared] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const toggle = async (next: boolean) => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/support/reports/${reportId}/screenshot-share`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shared: next }),
      });
      if (!res.ok) throw new Error();
      setShared(next);
    } catch {
      setError(t.common.error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 space-y-1">
      <label className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        <input type="checkbox" checked={shared} disabled={busy} onChange={(e) => void toggle(e.target.checked)} data-testid="report-screenshot-share" />
        {a.screenshotShare}
      </label>
      <p className="text-xs text-gray-500 dark:text-gray-400">{shared ? a.screenshotShareOn : a.screenshotShareHint}</p>
      {error && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
