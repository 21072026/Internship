'use client';

import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { useT } from '@/i18n/client';

// The partner's referral link, selectable and with a copy button.
export function CopyLink({ value }: { value: string }) {
  const L = useT().affiliatePortal;
  const toast = useToast();
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      toast(L.copied);
    } catch {
      // No clipboard (an insecure context, a refused permission): the text stays selectable.
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <code className="break-all rounded bg-gray-100 px-2 py-1 text-sm text-gray-900 dark:bg-gray-800 dark:text-gray-100" data-testid="affiliate-referral-link">
        {value}
      </code>
      <Button type="button" size="sm" variant="outline" onClick={() => void copy()}>
        {L.copy}
      </Button>
    </div>
  );
}
