'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { useT, useLocale } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';
import { ConvertInquiryModal, type ConvertibleInquiry } from '@/components/admin/ConvertInquiryModal';
import { useVertical } from '@/lib/verticalClient';
import { Building2, Mail, Phone, UserPlus, Kanban } from 'lucide-react';

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
  // The MARKETING demo form (#2569).
  marketplaces: string | null;
  marketingOptInRequested: boolean | null;
  marketingOptInConfirmedAt: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  referrer: string | null;
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
  // MARKETING (#2569): "convert" places the request on the pipeline — an
  // account, a lead and a funnel record — in one call, so there is no form to
  // fill in, only the outcome to show on the row.
  const isMarketing = useVertical() === 'MARKETING';
  const [placing, setPlacing] = useState<string | null>(null);
  const [placeResult, setPlaceResult] = useState<Record<string, { ok: boolean; text: string }>>({});

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

  const addToPipeline = async (r: InquiryRow) => {
    setPlacing(r.id);
    try {
      const res = await fetch(`/api/admin/company-inquiries/${r.id}/convert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const d = await res.json().catch(() => ({}));
      const c = a.convert;
      const text = res.ok
        ? c.leadDone.replace('{company}', d.companyName ?? r.companyName)
        : d.code === 'already_converted'
          ? d.companyName ? c.alreadyConverted.replace('{company}', d.companyName) : c.alreadyConvertedUnnamed
          : d.code === 'account_exists' || d.code === 'account_ambiguous' ? c.leadExists
          : d.code === 'contact_in_funnel' ? c.leadContactInFunnel
          : d.code === 'contact_is_user' ? c.leadContactIsUser
          : d.code === 'already_mentored' ? c.leadAlreadyMentored
          : d.code === 'in_progress' ? c.leadInProgress
          : d.code === 'invalid' ? c.leadInvalid
          : c.failed;
      setPlaceResult((prev) => ({ ...prev, [r.id]: { ok: res.ok, text } }));
      // Updated in place rather than reloaded: a converted request is CLOSED,
      // so a reload of the NEW tab would make the row vanish at the very
      // moment the admin wants to see what it became.
      if (res.ok && d.companyId) {
        setRows((prev) =>
          prev.map((x) =>
            x.id === r.id
              ? { ...x, status: 'CLOSED', convertedAt: new Date().toISOString(), convertedCompany: { id: d.companyId, name: d.companyName ?? r.companyName } }
              : x,
          ),
        );
      }
    } catch {
      setPlaceResult((prev) => ({ ...prev, [r.id]: { ok: false, text: a.convert.failed } }));
    } finally {
      setPlacing(null);
    }
  };
  const hasUnowned = isMarketing && rows.some((r) => !r.convertedCompany && r.status !== 'CLOSED');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{a.title}</h1>
        <p className="text-gray-500 mt-1">{a.subtitle}</p>
      </div>

      {hasUnowned && (
        <p data-testid="inquiries-unowned-hint" className="text-sm bg-amber-50 text-amber-800 border border-amber-200 rounded-lg px-4 py-3">
          {a.unownedHint}
        </p>
      )}

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
                    {isMarketing && !r.convertedCompany && r.status !== 'CLOSED' && (
                      <Badge variant="warning" data-testid={`inquiry-unowned-${r.id}`}>{a.unowned}</Badge>
                    )}
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
                  {!r.convertedCompany && isMarketing && (
                    <button
                      onClick={() => addToPipeline(r)}
                      disabled={placing === r.id}
                      data-testid={`convert-inquiry-${r.id}`}
                      className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:underline disabled:opacity-50"
                    >
                      <Kanban className="h-4 w-4" />
                      {placing === r.id ? a.convert.leadAdding : a.convert.leadAction}
                    </button>
                  )}
                  {!r.convertedCompany && !isMarketing && (
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
                    {(isMarketing ? a.convert.leadDone : a.convert.convertedTo).replace('{company}', r.convertedCompany.name)}
                    <Link href={`/admin/companies/${r.convertedCompany.id}`} className="text-blue-600 hover:underline">{a.convert.openCompany}</Link>
                  </p>
                )}
                {placeResult[r.id] && !placeResult[r.id].ok && (
                  <p data-testid={`inquiry-place-result-${r.id}`} className="text-sm bg-red-50 text-red-700 rounded-lg px-3 py-2">
                    {placeResult[r.id].text}
                  </p>
                )}
                {r.marketplaces && <p className="text-gray-700"><span className="text-gray-500">{a.marketplaces}:</span> {r.marketplaces}</p>}
                {(r.utmSource || r.utmCampaign || r.referrer) && (
                  <p className="text-gray-700" data-testid={`inquiry-source-${r.id}`}>
                    <span className="text-gray-500">{a.source}:</span>{' '}
                    {[r.utmSource, r.utmMedium, r.utmCampaign].filter(Boolean).join(' / ') || r.referrer}
                  </p>
                )}
                {/* A single opt-in from a public form: shown as what it is — a request —
                    so nobody reads it as permission to mail (UWG §7(2) Nr. 2). */}
                {r.marketingOptInRequested && (
                  <p className="text-gray-500 text-xs" data-testid={`inquiry-optin-${r.id}`}>
                    {r.marketingOptInConfirmedAt ? a.marketingOptInConfirmed : a.marketingOptIn}
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
