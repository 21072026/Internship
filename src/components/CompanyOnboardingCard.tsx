'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Circle } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { useT } from '@/i18n/client';
import { ONBOARDING_ITEMS, onboardingComplete, type OnboardingItem } from '@/lib/companySignup';

interface Onboarding {
  verificationStatus: string;
  rejectionReason: string | null;
  signupDomain: string | null;
  domainProofRecord: string | null;
  checklist: Record<OnboardingItem, boolean>;
}

const HREF: Record<OnboardingItem, string | null> = {
  profile: '/company/profile',
  requisition: '/company/requisitions',
  verified: null,
};

// The employer's first-hour card on /company (#1865): where verification
// stands, and a checklist DERIVED from live data (GET /api/company/onboarding),
// so nothing here can go stale. The whole card disappears once every item is
// done. While PENDING with a sign-up domain it offers the DNS fast path.
export function CompanyOnboardingCard() {
  const t = useT();
  const o = t.companyOnboarding;
  const [data, setData] = useState<Onboarding | null>(null);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch('/api/company/onboarding')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setData(d))
      .catch(() => setData(null));
  }, []);
  useEffect(() => load(), [load]);

  async function checkDomain() {
    setChecking(true);
    setMessage(null);
    try {
      const res = await fetch('/api/company/onboarding/domain-proof', { method: 'POST' });
      const body = await res.json().catch(() => null);
      if (body?.ok) load();
      else setMessage(body?.code === 'record_not_found' ? o.recordNotFound : o.checkFailed);
    } finally {
      setChecking(false);
    }
  }

  if (!data || onboardingComplete(data.checklist)) return null;
  const pending = data.verificationStatus !== 'VERIFIED';

  return (
    <Card className="mb-6" data-testid="company-onboarding">
      <CardHeader>
        <CardTitle>{o.title}</CardTitle>
      </CardHeader>
      {pending && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" data-testid="company-verification-banner">
          <p className="font-medium">{o.status[data.verificationStatus as keyof typeof o.status] ?? data.verificationStatus}</p>
          <p className="mt-1">{data.verificationStatus === 'PENDING' ? o.pendingBody : o.blockedBody}</p>
          {data.rejectionReason && <p className="mt-1">{o.reason}: {data.rejectionReason}</p>}
        </div>
      )}
      <ul className="space-y-2">
        {ONBOARDING_ITEMS.map((item) => {
          const done = data.checklist[item];
          const href = HREF[item];
          return (
            <li key={item} className="flex items-start gap-2 text-sm" data-testid={`onboarding-item-${item}`} data-done={done ? 'true' : 'false'}>
              {done ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-green-600" aria-hidden /> : <Circle className="mt-0.5 h-4 w-4 text-gray-400" aria-hidden />}
              <span className={done ? 'text-gray-500 line-through' : 'text-gray-900'}>
                {href && !done ? <Link href={href} className="text-blue-600 hover:underline">{o.items[item]}</Link> : o.items[item]}
                <span className="sr-only"> — {done ? o.done : o.todo}</span>
              </span>
            </li>
          );
        })}
      </ul>
      {data.domainProofRecord && data.signupDomain && (
        <div className="mt-4 space-y-2 text-sm" data-testid="company-domain-proof">
          <p>{o.domainProofIntro.replace('{domain}', data.signupDomain)}</p>
          <code className="block break-all rounded bg-gray-100 p-2 text-xs">{data.domainProofRecord}</code>
          <button
            type="button"
            onClick={() => void checkDomain()}
            disabled={checking}
            className="rounded border border-gray-300 px-3 py-1.5 text-xs hover:bg-gray-100 disabled:opacity-50"
            data-testid="company-domain-proof-check"
          >
            {o.checkDomain}
          </button>
          {message && <p role="status" className="text-xs text-gray-600">{message}</p>}
        </div>
      )}
    </Card>
  );
}
