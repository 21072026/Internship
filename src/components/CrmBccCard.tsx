'use client';

import { useCallback, useEffect, useState } from 'react';
import { Copy, Mail, RefreshCw } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

type State = { enabled: boolean; explicit: boolean; address: string | null; domainConfigured: boolean };

// The org's BCC-to-CRM address (#2809, docs/marketing-vertical/sales-email-capture.md).
// Staff put it in BCC; the CRM logs date + subject + recipients on the matching
// account. Rotating makes the old address dead at once — the answer to a leak.
export function CrmBccCard() {
  const t = useT();
  const s = t.settings;
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    fetch('/api/admin/crm-bcc')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setState(d))
      .catch(() => {});
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const act = async (action: 'rotate' | 'enable' | 'disable' | 'default') => {
    if (action === 'rotate' && !window.confirm(s.crmBccRotateConfirm)) return;
    setBusy(true);
    try {
      const res = await fetch('/api/admin/crm-bcc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (res.ok) setState(await res.json());
    } finally {
      setBusy(false);
      setCopied(false);
    }
  };

  const copy = async () => {
    if (!state?.address) return;
    try {
      await navigator.clipboard.writeText(state.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked — the address stays selectable.
    }
  };

  return (
    <Card className="mt-6" data-testid="crm-bcc-card">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Mail className="h-5 w-5 text-blue-600" />
          <CardTitle>{s.crmBccTitle}</CardTitle>
        </div>
      </CardHeader>
      <p className="mb-3 max-w-2xl text-sm text-gray-500 dark:text-gray-400">{s.crmBccHint}</p>
      {!state ? (
        <p className="text-sm text-gray-400">{t.common.loading}</p>
      ) : (
        <div className="space-y-3 max-w-2xl">
          {!state.enabled ? (
            <p className="text-sm text-gray-600 dark:text-gray-300" data-testid="crm-bcc-off">{s.crmBccOff}</p>
          ) : !state.address ? (
            <p className="text-sm text-amber-700 dark:text-amber-300" data-testid="crm-bcc-no-domain">{s.crmBccNoDomain}</p>
          ) : (
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={state.address}
                onFocus={(e) => e.target.select()}
                data-testid="crm-bcc-address"
                className="min-w-0 flex-1 rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-800 px-3 py-2 text-xs font-mono text-gray-600 dark:text-gray-300"
              />
              <Button type="button" variant="outline" size="sm" onClick={copy}>
                <Copy className="h-4 w-4" />
                {copied ? s.crmBccCopied : s.crmBccCopy}
              </Button>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {state.enabled && state.address && (
              <Button type="button" variant="outline" size="sm" loading={busy} onClick={() => act('rotate')} data-testid="crm-bcc-rotate">
                <RefreshCw className="h-4 w-4" />
                {s.crmBccRotate}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={busy}
              onClick={() => act(state.enabled ? 'disable' : 'enable')}
              data-testid="crm-bcc-toggle"
            >
              {state.enabled ? s.crmBccDisable : s.crmBccEnable}
            </Button>
            {state.explicit && (
              <Button type="button" variant="outline" size="sm" loading={busy} onClick={() => act('default')} data-testid="crm-bcc-default">
                {s.crmBccReset}
              </Button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
