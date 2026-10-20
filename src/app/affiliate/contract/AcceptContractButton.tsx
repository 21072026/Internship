'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function AcceptContractButton({ version, label, failed }: { version: number; label: string; failed: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function accept() {
    setBusy(true);
    const res = await fetch('/api/affiliate/me/contract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version }),
    });
    if (res.ok) {
      router.push('/affiliate');
      return;
    }
    setError(failed);
    setBusy(false);
  }

  return (
    <div className="space-y-2">
      {error && <p role="alert" className="text-sm">{error}</p>}
      <button type="button" onClick={accept} disabled={busy} className="rounded bg-black px-4 py-2 text-white disabled:opacity-50">
        {label}
      </button>
    </div>
  );
}
