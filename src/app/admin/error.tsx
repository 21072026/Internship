'use client';

import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

// App Router error boundary for everything under /admin. AdminLayout (sidebar,
// header) stays mounted above this — only the page content is replaced.
export default function AdminError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useT();

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex items-center justify-center py-20">
      <Card className="max-w-md w-full text-center">
        <AlertTriangle className="h-10 w-10 text-red-500 mx-auto mb-4" />
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">{t.errorBoundary.title}</h1>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{t.errorBoundary.description}</p>
        <div className="mt-6 flex items-center justify-center gap-3">
          <Button onClick={reset}>{t.errorBoundary.retry}</Button>
          <Button variant="outline" onClick={() => { window.location.href = '/admin'; }}>
            {t.errorBoundary.backHome}
          </Button>
        </div>
      </Card>
    </div>
  );
}
