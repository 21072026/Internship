import { Wallet } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { getServerDictionary } from '@/i18n/server';

// The partner portal's home (docs/affiliate-module.md). Link, customers and
// commissions follow with the portal step.
export default async function AffiliateHomePage() {
  const { t } = await getServerDictionary();
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.affiliatePortal.title}</h1>
      <EmptyState testId="affiliate-portal" icon={Wallet} title={t.affiliatePortal.title} body={t.affiliatePortal.emptyBody} />
    </div>
  );
}
