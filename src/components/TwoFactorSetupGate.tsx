'use client';

import { useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

// Standalone 2FA setup shown at the enforcement gate (/security-setup) for users
// whose role requires 2FA but who haven't enabled it yet. Reuses /api/account/2fa.
export function TwoFactorSetupGate({ home }: { home: string }) {
  const t = useT();
  const [setup, setSetup] = useState<{ secret: string; otpauth: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const run = async (action: 'setup' | 'enable') => {
    setBusy(true);
    setErr('');
    try {
      const res = await fetch('/api/account/2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, code }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      if (action === 'setup') setSetup({ secret: data.secret, otpauth: data.otpauth });
      else window.location.href = home; // enabled → the gate will let us through
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 p-4">
      <Card className="w-full max-w-md">
        <CardHeader><CardTitle>{t.securitySetup.title}</CardTitle></CardHeader>
        <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">{t.securitySetup.intro}</p>
        {err && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{err}</div>}

        {setup ? (
          <div className="space-y-3">
            <p className="text-sm text-gray-600 dark:text-gray-300">{t.account.twoFactorScan}</p>
            <p className="text-xs text-gray-500">{t.account.twoFactorSecret}:</p>
            <code className="block bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-sm break-all">{setup.secret}</code>
            <a href={setup.otpauth} className="text-xs text-blue-600 hover:underline break-all">{setup.otpauth}</a>
            <Input label={t.account.twoFactorCode} inputMode="numeric" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
            <Button loading={busy} disabled={!code} onClick={() => run('enable')}>{t.account.twoFactorConfirm}</Button>
          </div>
        ) : (
          <Button loading={busy} onClick={() => run('setup')}>{t.account.twoFactorEnable}</Button>
        )}
      </Card>
    </div>
  );
}
