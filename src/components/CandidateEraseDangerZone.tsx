'use client';

import { useRouter } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { UserEraseForm } from '@/components/UserEraseForm';
import { useT } from '@/i18n/client';

// Admin-initiated right-to-erasure on a candidate (EPIC: GDPR data retention).
// Two modes: anonymize (keeps the record, scrubs PII + files — preferred when
// history should stay visible for analytics) or permanent delete (full cascade
// removal). The confirmation gates live in UserEraseForm, which the admin user
// list uses too.
export function CandidateEraseDangerZone({ userId, fullName, onAnonymized }: {
  userId: string;
  fullName: string;
  onAnonymized: () => void;
}) {
  const t = useT();
  const c = t.erasure;
  const router = useRouter();

  return (
    <Card className="border-red-200 dark:border-red-900">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-red-700 dark:text-red-400">
          <AlertTriangle className="h-5 w-5" /> {c.title}
        </CardTitle>
      </CardHeader>
      <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">{c.hint}</p>
      <UserEraseForm
        userId={userId}
        fullName={fullName}
        allowAnonymize
        onDone={(mode) => {
          if (mode === 'delete') router.push('/admin/candidates');
          else onAnonymized();
        }}
      />
    </Card>
  );
}
