import { getServerSession } from 'next-auth';
import { BrandMark } from '@/components/BrandMark';
import { authOptions } from '@/lib/auth';
import { getOrgBranding } from '@/lib/orgBranding';
import { hostVertical } from '@/lib/hostVertical';
import { productNameFor } from '@/lib/verticals';

// White-label app wordmark (#546): shows the signed-in user's tenant brand — its
// logo (if set) or the default graduation-cap icon, plus the brand name. Falls
// back to the product default ("Internship CRM") when the org has no branding or
// there's no org, so single-tenant chrome is unchanged. Self-resolving server
// component so layouts can drop it in with no prop threading.
export async function BrandWordmark({ className, oneLine = false }: { className?: string; oneLine?: boolean }) {
  const session = await getServerSession(authOptions);
  const orgId = session?.user?.orgId;
  // Signed out (no org) on a marketing host, the wordmark should read the
  // vertical's product name, not "Internship CRM" (#2498). A signed-in tenant's
  // own brandName always overrides this. INTERNSHIP resolves to the same default
  // as before, so single-tenant chrome is unchanged.
  const noOrgFallbackName = orgId ? undefined : productNameFor(await hostVertical());
  const brand = await getOrgBranding(orgId, noOrgFallbackName);
  return (
    <span className={`flex items-center gap-2 ${oneLine ? 'min-w-0' : ''} ${className ?? ''}`}>
      {brand.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- tenant logo is an arbitrary external/stored URL
        <img src={brand.logoUrl} alt={brand.name} className="h-7 w-auto max-w-[150px] flex-shrink-0 object-contain" />
      ) : (
        <BrandMark className="h-7 w-7 flex-shrink-0 text-blue-600" />
      )}
      {/* Keep the mobile wordmark on one line; the regular sidebar/desktop
          wordmark may still wrap as before. A name too long for the bar ends in
          an ellipsis instead of running under the bar's buttons — `shrink-0` let
          a tenant name like "Acme Sales Demo (Marketing)" overlap the messages
          icon on a phone. A short name never reaches the limit, so it is not
          squeezed. */}
      <span className={`font-bold text-gray-900 dark:text-gray-100 ${oneLine ? 'min-w-0 truncate' : ''}`} title={oneLine ? brand.name : undefined}>{brand.name}</span>
    </span>
  );
}
