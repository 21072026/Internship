import { requirePortalPartner } from '@/lib/affiliatePortal';
import { ownRecord } from '@/lib/affiliateRecordRef';
import { getServerDictionary } from '@/i18n/server';
import { SupportChat } from '@/components/SupportChat';

// The partner's support thread (#3353): the ordinary support channel (#593),
// inside the portal — the partner shell does not open /messages. "Ask" on a
// commission or customer row lands here with `?record=`, which is shown only
// when the row is this partner's own; the API checks the same again on send.
export default async function AffiliateSupportPage({ searchParams }: { searchParams: Promise<{ record?: string }> }) {
  const { t } = await getServerDictionary();
  const portal = await requirePortalPartner();
  if (!portal) return <p className="text-sm text-gray-600 dark:text-gray-400">{t.affiliatePortal.noPartner}</p>;
  const asked = (await searchParams).record;
  const attach = asked ? await ownRecord({ orgId: portal.partner.orgId, partnerId: portal.partner.id }, asked) : null;
  return <SupportChat attach={attach} />;
}
