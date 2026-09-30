'use client';

import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

// "The request failed" — never the same screen as "there is nothing here"
// (#1374, #861). A page whose load fails renders this instead of spinning its
// skeleton forever, and the button re-runs the same load.
export function LoadErrorCard({ onRetry, testId = 'load-error' }: { onRetry: () => void; testId?: string }) {
  const t = useT();
  return (
    <Card className="mb-4" data-testid={testId}>
      <div role="alert" className="flex flex-col items-center gap-3 py-6 text-center">
        <p className="text-sm text-red-600 dark:text-red-400">{t.common.error}</p>
        <Button variant="outline" size="sm" onClick={onRetry} data-testid={`${testId}-retry`}>
          {t.errorBoundary.retry}
        </Button>
      </div>
    </Card>
  );
}
