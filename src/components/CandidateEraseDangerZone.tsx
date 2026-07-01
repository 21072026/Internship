'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, ShieldOff, Trash2 } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

type Mode = 'anonymize' | 'delete';

// Admin-initiated right-to-erasure on a candidate (EPIC: GDPR data retention).
// Two modes: anonymize (keeps the record, scrubs PII + files — preferred when
// history should stay visible for analytics) or permanent delete (full
// cascade removal). Gated behind typing the candidate's exact name, since an
// admin has no password to re-check for someone else's account.
export function CandidateEraseDangerZone({ userId, fullName, onAnonymized }: {
  userId: string;
  fullName: string;
  onAnonymized: () => void;
}) {
  const t = useT();
  const c = t.erasure;
  const router = useRouter();
  const [mode, setMode] = useState<Mode | null>(null);
  const [confirmName, setConfirmName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async () => {
    if (!mode) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/users/${userId}/erase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, confirmName }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || c.failed);
        return;
      }
      if (mode === 'delete') {
        router.push('/admin/candidates');
      } else {
        setMode(null);
        setConfirmName('');
        onAnonymized();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="border-red-200 dark:border-red-900">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-red-700 dark:text-red-400">
          <AlertTriangle className="h-5 w-5" /> {c.title}
        </CardTitle>
      </CardHeader>
      <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">{c.hint}</p>

      {!mode ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setMode('anonymize')}>
            <ShieldOff className="h-4 w-4 mr-1" /> {c.anonymize}
          </Button>
          <Button variant="danger" size="sm" onClick={() => setMode('delete')}>
            <Trash2 className="h-4 w-4 mr-1" /> {c.delete}
          </Button>
        </div>
      ) : (
        <div className="space-y-3 max-w-md">
          <p className="text-sm text-red-700 dark:text-red-400">
            {mode === 'delete' ? c.confirmDelete : c.confirmAnonymize}
          </p>
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
              {c.typeNameToConfirm.replace('{name}', fullName)}
            </label>
            <input
              type="text"
              data-testid="erasure-confirm-name"
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm"
            />
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex items-center gap-2">
            <Button
              variant="danger"
              size="sm"
              loading={busy}
              disabled={confirmName.trim() !== fullName}
              onClick={run}
            >
              {mode === 'delete' ? c.yesDelete : c.yesAnonymize}
            </Button>
            <Button variant="outline" size="sm" onClick={() => { setMode(null); setConfirmName(''); setError(''); }}>
              {t.common.cancel}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
