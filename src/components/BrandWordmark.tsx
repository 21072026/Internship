import { getServerSession } from 'next-auth';
import { GraduationCap } from 'lucide-react';
import { authOptions } from '@/lib/auth';
import { getOrgBranding } from '@/lib/orgBranding';

// White-label app wordmark (#546): shows the signed-in user's tenant brand — its
// logo (if set) or the default graduation-cap icon, plus the brand name. Falls
// back to the product default ("Internship CRM") when the org has no branding or
// there's no org, so single-tenant chrome is unchanged. Self-resolving server
// component so layouts can drop it in with no prop threading.
export async function BrandWordmark({ className }: { className?: string }) {
  const session = await getServerSession(authOptions);
  const brand = await getOrgBranding(session?.user?.orgId);
  return (
    <span className={`flex items-center gap-2 ${className ?? ''}`}>
      {brand.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- tenant logo is an arbitrary external/stored URL
        <img src={brand.logoUrl} alt={brand.name} className="h-7 w-auto max-w-[150px] object-contain" />
      ) : (
        <GraduationCap className="h-7 w-7 text-blue-600" />
      )}
      <span className="font-bold text-gray-900 dark:text-gray-100">{brand.name}</span>
    </span>
  );
}
