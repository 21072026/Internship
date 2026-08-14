import Link from 'next/link';
import { FlaskConical } from 'lucide-react';
import { getServerDictionary } from '@/i18n/server';

// Shown on every page of the public demo (#966). A server component so the
// DEMO_MODE flag stays server-side — the layout only renders this at all when
// IS_DEMO_MODE is true, so there is nothing to check here.
//
// Colors are pinned with dark: utilities rather than relying on the amber-50
// retint: this bar has to read as "not the real thing" in both themes, and the
// flat `bg-*-50` override in globals.css would dim it into the page.
export async function DemoModeBanner() {
  const { t } = await getServerDictionary();

  return (
    <div
      data-testid="demo-mode-banner"
      role="status"
      className="bg-amber-100 dark:!bg-amber-900/50 border-b border-amber-300 dark:!border-amber-700 px-4 py-2 text-center text-sm text-amber-900 dark:!text-amber-100"
    >
      <FlaskConical className="inline h-4 w-4 mb-0.5 mr-1.5" aria-hidden="true" />
      <span className="font-medium">{t.demo.bannerTitle}</span>{' '}
      <span className="text-amber-800 dark:!text-amber-200">{t.demo.bannerBody}</span>{' '}
      <Link href="/demo" className="underline font-medium hover:no-underline">
        {t.demo.bannerLink}
      </Link>
    </div>
  );
}
