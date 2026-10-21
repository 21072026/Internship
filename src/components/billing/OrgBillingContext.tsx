'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { BillingFeatureRow, BillingSummary } from '@/lib/billingSummary';

// ONE GET /api/org/billing per visit to /admin/billing (#1734): the shell
// fetches it and every tab reads the same payload from here, so adding a tab
// never adds a second billing request. A tab with data of its own (#1763's
// usage) fetches that itself; the bill is this.

/** GET /api/org/billing — the summary plus the resolved features (#1734). */
export interface OrgBilling extends BillingSummary {
  features: BillingFeatureRow[];
  // True for a super admin of this world: the features tab then offers the
  // grant form, whose endpoint decides again on every write.
  canGrant: boolean;
}

interface State {
  data: OrgBilling | null;
  failed: boolean;
  reload: () => void;
}

const Ctx = createContext<State>({ data: null, failed: false, reload: () => {} });

export function OrgBillingProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<OrgBilling | null>(null);
  const [failed, setFailed] = useState(false);
  const reload = useCallback(() => {
    setFailed(false);
    fetch('/api/org/billing')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: OrgBilling) => setData(d))
      .catch(() => setFailed(true));
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);
  return <Ctx.Provider value={{ data, failed, reload }}>{children}</Ctx.Provider>;
}

export function useOrgBilling(): State {
  return useContext(Ctx);
}
