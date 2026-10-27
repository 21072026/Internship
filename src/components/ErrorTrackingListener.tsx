'use client';

import { useEffect } from 'react';
import { browserErrorTrackingEnabled, reportBrowserError } from '@/lib/browserErrorReporter';

/**
 * Uncaught errors and unhandled rejections that no error boundary saw (#1600).
 * Renders nothing; with NEXT_PUBLIC_ERROR_TRACKING unset it attaches nothing.
 */
export function ErrorTrackingListener() {
  useEffect(() => {
    if (!browserErrorTrackingEnabled()) return;
    const onError = (e: ErrorEvent) => {
      // A failed <script>/<img> load has no `error` and is not a code bug.
      if (e.error) reportBrowserError(e.error, { scope: 'window' });
    };
    const onRejection = (e: PromiseRejectionEvent) => reportBrowserError(e.reason, { scope: 'unhandledrejection' });
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);
  return null;
}
