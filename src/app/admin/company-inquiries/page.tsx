'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { useT, useLocale } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';
import { ConvertInquiryModal, type ConvertibleInquiry } from '@/components/admin/ConvertInquiryModal';
import { Building2, Mail, Phone, UserPlus } from 'lucide-react';

interface InquiryRow {
  id: string;
  companyName: string;
  contactName: string;
  email: string;
  phone: string | null;
  openRoles: string | null;
  message: string | null;
  status: 'NEW' | 'CONTACTED' | 'CLOSED';
  createdAt: string;
  handledAt: string | null;
  handledBy: { fullName: string } | null;
  // Set once the enquiry has been converted into a Company + an invited COMPANY
  // login (#1863). The enquiry stays in the list either way — it is the record
  // of where the relationship came from — but it links to what it became instead
  // of offering to create a second one.
  convertedAt: string | null;
  convertedCompany: { id: string; name: string } | null;
}

const STATUS_TABS = ['NEW', 'CONTACTED', 'CLOSED', 'ALL'] as const;
const STATUS_VARIANT: Record<string, 'warning' | 'info' | 'success'> = {
  NEW: 'warning',
  CONTACTED: 'info',
  CLOSED: 'success',
};

// Where a company enquiry goes to be answered (#1104). The enquiry is stored
// rather than only emailed precisely so this screen can show what is still
// unanswered.
export default function CompanyInquiriesPage() {
  const t = useT();
  const locale = useLocale();
  const a = t.companyInquiriesAdmin;
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_TABS)[number]>('NEW');
  const [rows, setRows] = useState<InquiryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [converting, setConverting] = useState<ConvertibleInquiry | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    const qs = statusFilter === 'ALL' ? '' : `?status=${statusFilter}`;
    fetch(`/api/admin/company-inquiries${qs}`)
      .then((res) => (res.ok ? res.json() : { items: [] }))
      .then((d) => setRows(d.items ?? []))
      .finally(() => setLoading(false));
  }, [statusFilter]);

  useEffect(() => { load(); }, [load]);

  const setStatus = async (id: string, status: InquiryRow['status']) => {
    const res = await fetch('/api/admin/company-inquiries', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status }),
    });
    if (res.ok) load();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{a.title}</h1>
        <p className="text-gray-500 mt-1">{a.subtitle}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {STATUS_TABS.map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              statusFilter === s ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            {a.status[s.toLowerCase() as 'new' | 'contacted' | 'closed' | 'all']}
          </button>
        ))}
      </div>

      {loading ? (
        <SkeletonRows rows={4} />
      ) : rows.length === 0 ? (
        <EmptyState testId="company-inquiries" icon={Building2} title={a.emptyTitle} body={a.emptyBody} />
      ) : (
        <div className="space-y-4" data-testid="company-inquiries-list">
          {rows.map((r) => (
            <Card key={r.id}>
              <CardHeader className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                <div className="min-w-0">
                  <CardTitle className="flex items-center gap-2 flex-wrap">
                    {r.companyName}
                    <Badge variant={STATUS_VARIANT[r.status]}>
                      {a.status[r.status.toLowerCase() as 'new' | 'contacted' | 'closed']}
                    </Badge>
                  </CardTitle>
                  <p className="text-sm text-gray-500 mt-1">
                    {r.contactName} · {formatDate(r.createdAt, locale)}
                    {r.handledBy ? ` · ${a.handledBy.replace('{name}', r.handledBy.fullName)}` : ''}
                  </p>
                </div>
                <div className="flex gap-2 flex-shrink-0 flex-wrap">
                  {/* Offered on every enquiry that has not been converted yet,
                      including a manually closed one: a lead that went cold and
                      came back is exactly the case where somebody would
                      otherwise re-key it by hand on three screens. A converted
                      enquiry gets the link below instead, and the server refuses
                      a second conversion regardless of what this renders. */}
                  {!r.convertedCompany && (
                    <button
                      onClick={() => setConverting({ id: r.id, companyName: r.companyName, contactName: r.contactName, email: r.email })}
                      data-testid={`convert-inquiry-${r.id}`}
                      className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:underline"
                    >
                      <UserPlus className="h-4 w-4" />
                      {a.convert.action}
                    </button>
                  )}
                  {r.status !== 'CONTACTED' && (
                    <button onClick={() => setStatus(r.id, 'CONTACTED')} className="text-sm text-blue-600 hover:underline">
                      {a.markContacted}
                    </button>
                  )}
                  {r.status !== 'CLOSED' && (
                    <button onClick={() => setStatus(r.id, 'CLOSED')} className="text-sm text-gray-500 hover:underline">
                      {a.markClosed}
                    </button>
                  )}
                </div>
              </CardHeader>
              <div className="px-6 pb-6 space-y-2 text-sm">
                <p className="flex items-center gap-2 text-gray-700">
                  <Mail className="h-4 w-4 text-gray-400" />
                  <a href={`mailto:${r.email}`} className="text-blue-600 hover:underline">{r.email}</a>
                </p>
                {r.phone && (
                  <p className="flex items-center gap-2 text-gray-700">
                    <Phone className="h-4 w-4 text-gray-400" />{r.phone}
                  </p>
                )}
                {r.convertedCompany && (
                  <p
                    data-testid={`inquiry-converted-${r.id}`}
                    className="flex flex-wrap items-center gap-2 bg-green-50 text-green-800 rounded-lg px-3 py-2"
                  >
                    <Building2 className="h-4 w-4" />
                    {a.convert.convertedTo.replace('{company}', r.convertedCompany.name)}
                    <a href="/admin/companies" className="text-blue-600 hover:underline">{a.convert.openCompany}</a>
                  </p>
                )}
                {r.openRoles && <p className="text-gray-700"><span className="text-gray-500">{a.openRoles}:</span> {r.openRoles}</p>}
                {r.message && <p className="text-gray-600 whitespace-pre-wrap border-l-2 border-gray-200 pl-3">{r.message}</p>}
              </div>
            </Card>
          ))}
        </div>
      )}

      {converting && (
        <ConvertInquiryModal
          inquiry={converting}
          onClose={() => setConverting(null)}
          onConverted={load}
        />
      )}
    </div>
  );
}
