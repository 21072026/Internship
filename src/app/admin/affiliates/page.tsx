'use client';

import { Wallet } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { useT } from '@/i18n/client';

// The partner programme's home (docs/affiliate-module.md). For now only the
// entry point the sidebar opens; partners, payments and payouts follow.
export default function AdminAffiliatesPage() {
  const t = useT();
  const L = t.affiliateAdmin;
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{L.title}</h1>
      <EmptyState testId="affiliates" icon={Wallet} title={L.emptyTitle} body={L.emptyBody} />
    </div>
  );
}
