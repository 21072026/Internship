'use client';

import { useT } from '@/i18n/client';
import { OwnerApiKeys } from '@/components/integrations/OwnerApiKeys';
import { OwnerWebhooks } from '@/components/integrations/OwnerWebhooks';

// A COMPANY owner's own API keys and webhooks (#2006). The screens are the
// shared OwnerApiKeys / OwnerWebhooks (also /source/integrations); the routes
// decide everything.
export default function CompanyIntegrationsPage() {
  const t = useT();
  return (
    <OwnerApiKeys
      endpoint="/api/company/integrations/api-keys"
      scopes={['hiring:read']}
      labels={t.companyIntegrations}
      scopeLabel={t.companyIntegrations.scopeHiring}
      extra={(onLocked) => <OwnerWebhooks endpoint="/api/company/integrations/webhooks" labels={t.companyIntegrations} onLocked={onLocked} />}
    />
  );
}
