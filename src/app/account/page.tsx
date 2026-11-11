'use client';

import { AccountSettings } from '@/components/AccountSettings';
import { KudosReceived } from '@/components/KudosPanel';

export default function AccountPage() {
  return (
    <>
      <AccountSettings />
      {/* Thank-yous received inside a mentorship (#1868); nothing when none. */}
      <KudosReceived />
    </>
  );
}
