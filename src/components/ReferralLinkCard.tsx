'use client';

import { useEffect, useState } from 'react';
import { Copy, Check, Share2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

// "Send it to your circle" (#51). Every role gets the same mechanism — a mentee
// inviting friends, a mentor or admin sharing a link — and whoever registers
// through it is recorded as having come from the link's owner, which is what makes
// people (not just institutions) usable as a referral source.
export function ReferralLinkCard() {
  const t = useT();
  const [url, setUrl] = useState('');
  const [count, setCount] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch('/api/referral')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setUrl(d.url ?? '');
        setCount(d.count ?? 0);
      })
      .catch(() => {});
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the input below is selectable, so nothing is lost */
    }
  };

  if (!url) return null;

  return (
    <Card className="mb-6" data-testid="referral-card">
      <div className="mb-1 flex items-center gap-2">
        <Share2 className="h-4 w-4 text-blue-500" />
        <span className="font-medium text-gray-900 dark:text-gray-100">{t.referral.title}</span>
      </div>
      <p className="mb-3 text-sm text-gray-500">{t.referral.hint}</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          aria-label={t.referral.yourLink}
          data-testid="referral-url"
          className="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 bg-gray-50 px-2.5 py-1.5 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 sm:flex-1"
        />
        <Button type="button" size="sm" variant="outline" className="w-full sm:w-auto" onClick={copy} data-testid="referral-copy">
          {copied ? <Check className="mr-1 h-3.5 w-3.5" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
          {copied ? t.referral.copied : t.referral.copy}
        </Button>
      </div>
      <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">
        {count > 0 ? t.referral.referredCount.replace('{n}', String(count)) : t.referral.none}
      </p>
    </Card>
  );
}
