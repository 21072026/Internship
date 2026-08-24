'use client';

import { Suspense } from 'react';
import { TargetedEmailComposer } from '@/components/TargetedEmailComposer';

// Admin parity (#708): admins can send targeted email to mentees, mirroring the
// mentor screen. Reuses the shared composer; /api/mentor/email already authorizes
// ADMIN and /api/mentorship returns all relations for admins.
//
// Suspense boundary: the composer reads ?relation=&template= to prefill an
// outcome message (#830), and useSearchParams needs one.
export default function AdminEmailPage() {
  return (
    <Suspense fallback={null}>
      <TargetedEmailComposer />
    </Suspense>
  );
}
