'use client';

import { useT } from '@/i18n/client';
import { OwnerApiKeys } from '@/components/integrations/OwnerApiKeys';
import { OwnerWebhooks } from '@/components/integrations/OwnerWebhooks';

// A SOURCE owner's own API keys and webhooks (#2006): the same screens as a
// company's, over the candidates the source referred. The routes
// (/api/source/integrations/*) decide everything.
export default function SourceIntegrationsPage() {
  const t = useT();
  const labels = { ...t.companyIntegrations, ...t.sourceIntegrations };
  return (
    <OwnerApiKeys
      endpoint="/api/source/integrations/api-keys"
      scopes={['candidates:read']}
      labels={labels}
      scopeLabel={t.sourceIntegrations.scopeCandidates}
      extra={(onLocked) => <OwnerWebhooks endpoint="/api/source/integrations/webhooks" labels={labels} onLocked={onLocked} />}
    />
  );
}
