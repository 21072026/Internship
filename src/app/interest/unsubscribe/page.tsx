import { SubscriberAction } from '@/components/SubscriberAction';
import { PublicShell } from '@/components/landing/PublicShell';
import { NO_INDEX } from '@/lib/pageMetadata';
export const metadata = { ...NO_INDEX, referrer: 'no-referrer' as const };
export default async function Page({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  const { t } = await searchParams;
  return <PublicShell><SubscriberAction action="unsubscribe" token={t ?? ''} /></PublicShell>;
}
