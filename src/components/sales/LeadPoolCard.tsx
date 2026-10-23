'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Inbox } from 'lucide-react';
import { useT } from '@/i18n/client';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { interpolate } from '@/lib/notificationText';

// The unassigned lead pool on /sales (src/lib/leadClaim.ts): leads the Klaviyo
// connector brought in that nobody has taken yet. "Take it" puts one on the
// rep's own book at the first stage; a colleague who was faster gets `taken`
// and the row disappears. Reads and writes /api/sales/pool.

interface PoolLead {
  id: string;
  fullName: string;
  phone: string | null;
  city: string | null;
  createdAt: string;
  company: { id: string; name: string; contactEmail: string | null } | null;
  source: string | null;
}

export function LeadPoolCard() {
  const t = useT();
  const p = t.sales.pool;
  const router = useRouter();
  const [leads, setLeads] = useState<PoolLead[] | null>(null);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/sales/pool');
    if (!res.ok) {
      setLeads([]);
      return;
    }
    const data = await res.json();
    setLeads(data.leads ?? []);
    setTotal(data.total ?? 0);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const take = async (lead: PoolLead) => {
    setBusy(lead.id);
    setMessage(null);
    try {
      const res = await fetch(`/api/sales/pool/${lead.id}/claim`, { method: 'POST' });
      if (res.status === 201) {
        const data = await res.json();
        router.push(`/sales/leads/${data.relationId}`);
        return;
      }
      setMessage(res.status === 409 ? p.taken : p.failed);
      await load();
    } finally {
      setBusy(null);
    }
  };

  if (leads === null || (leads.length === 0 && total === 0)) {
    return leads === null ? null : (
      <Card className="mb-8" id="lead-pool" data-testid="lead-pool">
        <CardHeader>
          <CardTitle>{p.title}</CardTitle>
        </CardHeader>
        <p className="text-sm text-gray-500" data-testid="lead-pool-empty">{p.empty}</p>
      </Card>
    );
  }

  return (
    <Card className="mb-8" id="lead-pool" data-testid="lead-pool">
      <CardHeader>
        <CardTitle>
          <span className="inline-flex items-center gap-2">
            <Inbox className="h-5 w-5" aria-hidden="true" />
            {p.title}
          </span>
        </CardTitle>
      </CardHeader>
      <p className="mb-3 text-sm text-gray-500">{interpolate(p.hint, { count: String(total) })}</p>
      {message && (
        <p role="status" className="mb-3 text-sm text-red-600 dark:text-red-400" data-testid="lead-pool-message">
          {message}
        </p>
      )}
      <div className="overflow-x-auto" tabIndex={0} aria-label={p.title} role="region">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-xs text-gray-500">
              <th scope="col" className="py-2 pr-4 font-medium">{p.columns.person}</th>
              <th scope="col" className="py-2 pr-4 font-medium">{p.columns.email}</th>
              <th scope="col" className="py-2 pr-4 font-medium">{p.columns.phone}</th>
              <th scope="col" className="py-2 pr-4 font-medium">{p.columns.source}</th>
              <th scope="col" className="py-2 pr-4 font-medium">{p.columns.created}</th>
              <th scope="col" className="py-2 font-medium"><span className="sr-only">{p.take}</span></th>
            </tr>
          </thead>
          <tbody>
            {leads.map((lead) => (
              <tr key={lead.id} className="border-b border-gray-100 align-top last:border-0" data-testid={`lead-pool-row-${lead.id}`}>
                <td className="py-2 pr-4">
                  <span className="font-medium text-gray-900 dark:text-gray-100">{lead.fullName}</span>
                  {lead.company && lead.company.name !== lead.fullName && (
                    <p className="text-xs text-gray-500">{lead.company.name}</p>
                  )}
                </td>
                <td className="py-2 pr-4 break-all">{lead.company?.contactEmail ?? p.none}</td>
                <td className="py-2 pr-4 whitespace-nowrap">{lead.phone ?? p.none}</td>
                <td className="py-2 pr-4">{lead.source ?? p.none}</td>
                <td className="py-2 pr-4 whitespace-nowrap"><RelativeTime date={lead.createdAt} /></td>
                <td className="py-2 text-right">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => take(lead)}
                    loading={busy === lead.id}
                    disabled={busy !== null}
                    data-testid={`lead-pool-take-${lead.id}`}
                  >
                    {p.take}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
