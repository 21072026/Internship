'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useT } from '@/i18n/client';

const LAST_SEEN_KEY = 'lastSeenReleaseVersion';

// Small sidebar footer: app version + a link to /release-notes. Shows a dot
// when the current version hasn't been seen yet (per-browser, localStorage);
// visiting the page (or this footer once) marks it seen.
export function VersionFooter({ version }: { version: string }) {
  const t = useT();
  const [isNew, setIsNew] = useState(false);

  useEffect(() => {
    try {
      const lastSeen = localStorage.getItem(LAST_SEEN_KEY);
      if (lastSeen !== version) setIsNew(true);
    } catch { /* ignore */ }
  }, [version]);

  const markSeen = () => {
    try { localStorage.setItem(LAST_SEEN_KEY, version); } catch { /* ignore */ }
    setIsNew(false);
  };

  return (
    <Link
      href="/release-notes"
      onClick={markSeen}
      className="relative inline-flex items-center gap-1 text-xs text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
      title={t.releaseNotes.title}
    >
      v{version}
      {isNew && <span className="h-1.5 w-1.5 rounded-full bg-blue-500" aria-label={t.releaseNotes.title} />}
    </Link>
  );
}
