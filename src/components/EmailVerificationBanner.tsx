'use client';

import { useState } from 'react';
import { useSession } from 'next-auth/react';
import { AlertTriangle } from 'lucide-react';
import { useT } from '@/i18n/client';

// Shown to signed-in users whose email isn't verified yet. While unverified the
// app is read-only (enforced server-side in middleware); this offers a re-send.
export function EmailVerificationBanner() {
  const t = useT();
  const { data: session } = useSession();
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);

  if (!session || session.user?.emailVerified !== false) return null;

  const resend = async () => {
    setSending(true);
    try {
      await fetch('/api/auth/verify-email/resend', { method: 'POST' });
      setSent(true);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span className="flex-1 min-w-0">{t.auth.unverifiedBanner}</span>
      {sent ? (
        <span className="font-medium">{t.auth.verifyResent}</span>
      ) : (
        <button
          onClick={resend}
          disabled={sending}
          className="font-medium underline hover:no-underline disabled:opacity-50"
        >
          {t.auth.verifyResend}
        </button>
      )}
    </div>
  );
}
