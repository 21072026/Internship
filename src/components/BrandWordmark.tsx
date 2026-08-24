import { getServerSession } from 'next-auth';
import { GraduationCap } from 'lucide-react';
import { authOptions } from '@/lib/auth';
import { getOrgBranding } from '@/lib/orgBranding';

// White-label app wordmark (#546): shows the signed-in user's tenant brand — its
// logo (if set) or the default graduation-cap icon, plus the brand name. Falls
// back to the product default ("Internship CRM") when the org has no branding or
// there's no org, so single-tenant chrome is unchanged. Self-resolving server
// component so layouts can drop it in with no prop threading.
export async function BrandWordmark({ className, oneLine = false }: { className?: string; oneLine?: boolean }) {
  const session = await getServerSession(authOptions);
  const brand = await getOrgBranding(session?.user?.orgId);
  return (
    <span className={`flex items-center gap-2 ${oneLine ? 'min-w-0' : ''} ${className ?? ''}`}>
      {brand.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- tenant logo is an arbitrary external/stored URL
        <img src={brand.logoUrl} alt={brand.name} className="h-7 w-auto max-w-[150px] flex-shrink-0 object-contain" />
      ) : (
        <GraduationCap className="h-7 w-7 flex-shrink-0 text-blue-600" />
      )}
      {/* `oneLine` (the mobile top bar) truncates the *name* when the row runs
          out of room. That bar used to truncate the whole row instead, which cut
          the beta badge in half — a 360px phone read "Internship CRM BI" (#1305).
          Everywhere else the name may wrap, which loses nothing. */}
      <span className={`font-bold text-gray-900 dark:text-gray-100 ${oneLine ? 'truncate' : ''}`}>{brand.name}</span>
    </span>
  );
}
