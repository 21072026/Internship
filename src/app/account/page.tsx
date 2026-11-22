'use client';

import Link from 'next/link';
import { MessageSquareWarning } from 'lucide-react';
import { AccountSettings } from '@/components/AccountSettings';
import { KudosReceived } from '@/components/KudosPanel';
import { useT } from '@/i18n/client';

export default function AccountPage() {
  const t = useT();
  return (
    <>
      {/* The reports this person sent with the feedback button (#3877). */}
      <Link
        href="/account/feedback"
        className="mb-4 inline-flex min-h-11 items-center gap-2 text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
        data-testid="account-my-feedback"
      >
        <MessageSquareWarning className="h-4 w-4" aria-hidden="true" />
        {t.myFeedback.link}
      </Link>
      <AccountSettings />
      {/* Thank-yous received inside a mentorship (#1868); nothing when none. */}
      <KudosReceived />
    </>
  );
}
