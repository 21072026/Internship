'use client';

import { useT } from '@/i18n/client';
import { OwnerApiKeys } from '@/components/integrations/OwnerApiKeys';
import { CompanyWebhooks } from './CompanyWebhooks';

// A COMPANY owner's own API keys and webhooks (#2006). The screen is the shared
// OwnerApiKeys (also /source/integrations); the route decides everything.
export default function CompanyIntegrationsPage() {
  const t = useT();
  return (
    <OwnerApiKeys
      endpoint="/api/company/integrations/api-keys"
      scopes={['hiring:read']}
      labels={t.companyIntegrations}
      scopeLabel={t.companyIntegrations.scopeHiring}
      extra={(onLocked) => <CompanyWebhooks onLocked={onLocked} />}
    />
  );
}
