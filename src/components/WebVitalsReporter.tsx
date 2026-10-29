'use client';

import { useRef } from 'react';
import { usePathname } from 'next/navigation';
import { useReportWebVitals } from 'next/web-vitals';
import { routeTemplate, webVitalsSampleRate, WEB_VITAL_NAMES } from '@/lib/webVitalsRule';

const RATE = webVitalsSampleRate(process.env.NEXT_PUBLIC_WEB_VITALS_SAMPLE_RATE);
const NAMES = new Set<string>(WEB_VITAL_NAMES);

/**
 * Core Web Vitals from real visitors (#1593), sampled per page load. With
 * NEXT_PUBLIC_WEB_VITALS_SAMPLE_RATE unset (the default) it sends nothing.
 * Samples go to our own `/api/telemetry/vitals` — no third-party host.
 */
export function WebVitalsReporter() {
  const pathname = usePathname();
  // One coin toss per mount, so a page load reports all of its metrics or none.
  const sampled = useRef(RATE > 0 && Math.random() < RATE);
  useReportWebVitals((metric) => {
    if (!sampled.current || !NAMES.has(metric.name)) return;
    const body = JSON.stringify({
      name: metric.name,
      value: metric.value,
      rating: metric.rating,
      route: routeTemplate(pathname || window.location.pathname),
      navigationType: metric.navigationType,
    });
    try {
      if (!navigator.sendBeacon?.('/api/telemetry/vitals', new Blob([body], { type: 'application/json' }))) {
        void fetch('/api/telemetry/vitals', { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'application/json' } }).catch(() => {});
      }
    } catch {
      // Measurement must never break the page.
    }
  });
  return null;
}
