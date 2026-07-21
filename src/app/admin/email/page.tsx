'use client';

import { TargetedEmailComposer } from '@/components/TargetedEmailComposer';

// Admin parity (#708): admins can send targeted email to mentees, mirroring the
// mentor screen. Reuses the shared composer; /api/mentor/email already authorizes
// ADMIN and /api/mentorship returns all relations for admins.
export default function AdminEmailPage() {
  return <TargetedEmailComposer />;
}
