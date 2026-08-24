'use client';

import { Suspense } from 'react';
import { TargetedEmailComposer } from '@/components/TargetedEmailComposer';

// Suspense boundary: the composer reads ?relation=&template= to prefill an
// outcome message (#830), and useSearchParams needs one.
export default function MentorEmailPage() {
  return (
    <Suspense fallback={null}>
      <TargetedEmailComposer />
    </Suspense>
  );
}
