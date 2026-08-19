'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

// Convert a MENTOR ↔ MENTEE account (#1243), from anywhere an admin looks at
// the person — the users list and both profile pages (#1252). Kept as a
// confirm step: the endpoint revokes every session the person has, which
// deserves a pause. The person is told what happened (in-app + email) by the
// endpoint itself, so callers only need to refresh their own view via onDone.
export function RoleConvertButton({
  userId,
  fullName,
  role,
  onDone,
}: {
  userId: string;
  fullName: string;
  role: string;
  onDone: () => void | Promise<void>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // People-roles only: ADMIN is not grantable through the endpoint, and
  // COMPANY/SOURCE accounts carry structural links (it refuses them too).
  if (role !== 'MENTOR' && role !== 'MENTEE') return null;
  const toMentor = role === 'MENTEE';

  const convert = async () => {
    if (busy) return; // guard against a double-click firing two conversions
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: toMentor ? 'MENTOR' : 'MENTEE' }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? t.common.error);
      }
      setOpen(false);
      await onDone();
    } catch (e) {
      setError(t.usersAdmin.convertFailed.replace('{e}', e instanceof Error ? e.message : String(e)));
      // Refresh alongside the error: the usual cause is a stale row (another
      // tab or admin already changed the account), and retrying against it
      // would just loop on the same answer.
      await onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-w-0">
      <Button
        variant="ghost"
        size="sm"
        data-testid={`convert-role-${userId}`}
        onClick={() => { setOpen(!open); setError(null); }}
      >
        {toMentor ? t.usersAdmin.makeMentor : t.usersAdmin.makeMentee}
      </Button>
      {error && (
        <p className="text-xs text-red-600 mt-1" data-testid={`convert-role-error-${userId}`}>{error}</p>
      )}
      {open && (
        <div className="mt-3 rounded-lg border border-amber-200 dark:border-amber-900 p-3">
          <p className="text-sm text-gray-700 dark:text-gray-300">
            {(toMentor ? t.usersAdmin.convertToMentorConfirm : t.usersAdmin.convertToMenteeConfirm).replace('{name}', fullName)}
          </p>
          <div className="flex gap-2 mt-3">
            <Button
              size="sm"
              loading={busy}
              data-testid={`convert-role-confirm-${userId}`}
              onClick={convert}
            >
              {t.usersAdmin.convertConfirm}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { setOpen(false); setError(null); }}>
              {t.common.cancel}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
