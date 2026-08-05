'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { X } from 'lucide-react';
import { useT } from '@/i18n/client';

const STORAGE_KEY = 'mentor-profile-completion-banner-dismissed';

export function MentorProfileCompletionBanner() {
  const t = useT();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(sessionStorage.getItem(STORAGE_KEY) !== 'true');
  }, []);

  if (!visible) return null;

  return (
    <div
      data-testid="mentor-profile-completion-banner"
      className="mb-6 flex flex-wrap items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-100"
    >
      <span className="font-medium">{t.mentor.profileCompletion.title}</span>
      <span>{t.mentor.profileCompletion.hint}</span>
      <Link href="/mentor/profile" className="font-medium underline underline-offset-2 hover:text-blue-700 dark:hover:text-blue-200">
        {t.mentor.profileCompletion.cta} →
      </Link>
      <button
        type="button"
        aria-label={t.mentor.profileCompletion.dismiss}
        className="ml-auto rounded p-1 hover:bg-blue-100 dark:hover:bg-blue-900/50"
        onClick={() => {
          sessionStorage.setItem(STORAGE_KEY, 'true');
          setVisible(false);
        }}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
