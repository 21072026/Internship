'use client';

import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { useT } from '@/i18n/client';

const PRODUCTION_URL = 'https://crm.ersah.in';

/**
 * Sticky top banner shown on every page when the app runs in demo mode
 * (DEMO_MODE=true).  Tells visitors this is an ephemeral sandbox and gives
 * them a direct link to sign up on the production instance.
 */
export function DemoModeBanner() {
  const t = useT();
  const d = t.demoMode;

  return (
    <div
      className="sticky top-0 z-50 flex items-center justify-between gap-4 bg-amber-500 px-4 py-2 text-sm text-white shadow-sm"
      role="banner"
      data-testid="demo-mode-banner"
    >
      <div className="flex items-center gap-2 min-w-0">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="truncate">{d.banner}</span>
      </div>
      <Link
        href={PRODUCTION_URL}
        className="shrink-0 rounded-full bg-white px-3 py-0.5 text-xs font-semibold text-amber-700 hover:bg-amber-50 transition-colors whitespace-nowrap"
        target="_blank"
        rel="noopener noreferrer"
      >
        {d.bannerCta}
      </Link>
    </div>
  );
}
