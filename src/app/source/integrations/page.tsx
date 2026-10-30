'use client';

import { useT } from '@/i18n/client';
import { OwnerApiKeys } from '@/components/integrations/OwnerApiKeys';

// A SOURCE owner's own API keys (#2006): the same screen as a company's
// (OwnerApiKeys), over the candidates the source referred. The route
// (/api/source/integrations/api-keys) decides everything.
export default function SourceIntegrationsPage() {
  const t = useT();
  return (
    <OwnerApiKeys
      endpoint="/api/source/integrations/api-keys"
      scopes={['candidates:read']}
      labels={{ ...t.companyIntegrations, ...t.sourceIntegrations }}
      scopeLabel={t.sourceIntegrations.scopeCandidates}
    />
  );
}
