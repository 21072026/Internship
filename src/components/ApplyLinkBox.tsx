'use client';

import { useState } from 'react';
import { useSession } from 'next-auth/react';
import { Link2, Copy, Check } from 'lucide-react';
import { useT } from '@/i18n/client';
import { copyToClipboard } from '@/lib/clipboard';

// Shows the mentor their shareable public application link.
export function ApplyLinkBox() {
  const t = useT();
  const { data: session } = useSession();
  const [copied, setCopied] = useState(false);

  if (!session?.user?.id) return null;
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const url = `${origin}/apply/${session.user.id}`;

  return (
    <div className="mb-6 rounded-xl border border-blue-100 bg-blue-50 p-4">
      <p className="flex items-center gap-2 text-sm font-medium text-blue-900">
        <Link2 className="h-4 w-4" /> {t.applyLink.shareTitle}
      </p>
      <p className="text-xs text-blue-700 mt-1 mb-2">{t.applyLink.shareHint}</p>
      <div className="flex items-center gap-2">
        <input
          readOnly
          value={url}
          onFocus={(e) => e.target.select()}
          className="flex-1 px-3 py-2 border border-blue-200 rounded-lg text-sm bg-white text-gray-700"
        />
        <button
          onClick={async () => {
          const didCopy = await copyToClipboard(url);

          if (!didCopy) return;

          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
          className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-blue-600 text-white text-sm hover:bg-blue-700"
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? t.applyLink.copied : t.applyLink.copy}
        </button>
      </div>
    </div>
  );
}
