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
  // The freshly minted recovery codes, held for the one render they exist in.
  const [codes, setCodes] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);

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
      // Enrolment mints the recovery codes and returns them in THIS response
      // and no other (#1542), so the gate has to stop and show them. Redirecting
      // straight through — as it used to — would throw away the only copy, and
      // it would do it to exactly the population that needs them most: people
      // whose organisation forced 2FA on them, not people who chose it.
      else if (Array.isArray(data.recoveryCodes) && data.recoveryCodes.length > 0) {
        setCodes(data.recoveryCodes.map(String));
      } else {
        window.location.href = home; // enabled → the gate will let us through
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    if (!codes) return;
    const blob = new Blob([`${codes.join('\n')}\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'internship-crm-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 p-4">
      <Card className="w-full max-w-md">
        <CardHeader><CardTitle>{t.securitySetup.title}</CardTitle></CardHeader>
        <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">{t.securitySetup.intro}</p>
        {err && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{err}</div>}

        {codes ? (
          <div className="space-y-3" data-testid="gate-recovery-codes">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t.account.recoveryTitle}</h2>
            <p className="text-sm text-gray-600 dark:text-gray-300">{t.account.recoveryHint}</p>
            <p className="text-sm font-medium text-amber-700 dark:text-amber-300">{t.account.recoverySaveNow}</p>
            <ul
              className="grid grid-cols-2 gap-1 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 font-mono text-sm text-gray-900"
              data-testid="gate-recovery-codes-list"
            >
              {codes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(codes.join('\n'));
                    setCopied(true);
                  } catch {
                    // On screen and downloadable anyway — not worth an error.
                  }
                }}
              >
                {copied ? t.account.recoveryCopied : t.account.recoveryCopy}
              </Button>
              <Button variant="outline" onClick={download}>{t.account.recoveryDownload}</Button>
            </div>
            <Button onClick={() => { window.location.href = home; }} data-testid="gate-recovery-continue">
              {t.securitySetup.continueLabel}
            </Button>
          </div>
        ) : setup ? (
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
