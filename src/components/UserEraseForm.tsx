'use client';

import { useState } from 'react';
import { ShieldOff, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

export type EraseMode = 'anonymize' | 'delete';

/**
 * Shared confirmation form for admin-initiated erasure of someone else's
 * account (`POST /api/admin/users/[id]/erase`). Used by the candidate danger
 * zone and by the admin user list.
 *
 * Two gates, on purpose:
 * - typing the target's exact full name — a misclick guard;
 * - the acting admin's OWN password — real step-up authentication, so a
 *   hijacked admin session can't erase accounts silently. It is never the
 *   target's password: an admin cannot know that one, which is exactly why
 *   trying to delete an account from an impersonated session was a dead end.
 */
export function UserEraseForm({ userId, fullName, allowAnonymize, onDone, onCancel, autoOpenMode }: {
  userId: string;
  fullName: string;
  /** Anonymizing only preserves anything meaningful for candidates (MENTEE). */
  allowAnonymize: boolean;
  onDone: (mode: EraseMode) => void;
  /** Set when the parent owns the open/closed state (the user-list row). */
  onCancel?: () => void;
  /** Skip the mode picker (the user list opens straight into deletion). */
  autoOpenMode?: EraseMode;
}) {
  const t = useT();
  const c = t.erasure;
  const [mode, setMode] = useState<EraseMode | null>(autoOpenMode ?? null);
  const [confirmName, setConfirmName] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const cancel = () => {
    setMode(autoOpenMode ?? null);
    setConfirmName('');
    setAdminPassword('');
    setError('');
    onCancel?.();
  };

  const run = async () => {
    if (!mode) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/users/${userId}/erase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, confirmName, adminPassword }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || c.failed);
        return;
      }
      setAdminPassword('');
      onDone(mode);
    } finally {
      setBusy(false);
    }
  };

  if (!mode) {
    return (
      <div className="flex flex-wrap gap-2">
        {allowAnonymize && (
          <Button variant="outline" size="sm" onClick={() => setMode('anonymize')}>
            <ShieldOff className="h-4 w-4 mr-1" /> {c.anonymize}
          </Button>
        )}
        <Button variant="danger" size="sm" onClick={() => setMode('delete')}>
          <Trash2 className="h-4 w-4 mr-1" /> {c.delete}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3 max-w-md" data-testid="erasure-form">
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
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">{c.adminPassword}</label>
        <input
          type="password"
          autoComplete="current-password"
          data-testid="erasure-admin-password"
          value={adminPassword}
          onChange={(e) => setAdminPassword(e.target.value)}
          className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm"
        />
        <p className="text-xs text-gray-400 mt-1">{c.adminPasswordHint}</p>
      </div>
      {error && <p className="text-xs text-red-600" data-testid="erasure-error">{error}</p>}
      <div className="flex items-center gap-2">
        <Button
          variant="danger"
          size="sm"
          loading={busy}
          disabled={confirmName.trim() !== fullName || !adminPassword}
          onClick={run}
        >
          {mode === 'delete' ? c.yesDelete : c.yesAnonymize}
        </Button>
        <Button variant="outline" size="sm" onClick={cancel}>{t.common.cancel}</Button>
      </div>
    </div>
  );
}
