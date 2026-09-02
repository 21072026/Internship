'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { FileSignature, Search } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/EmptyState';
import { useT, useLocale } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';
import { DECLINE_REASON_CODES, OFFER_STATUSES } from '@/lib/offers';

interface OfferRow {
  id: string;
  status: string;
  position: string;
  sentAt: string | null;
  expiresAt: string | null;
  decidedAt: string | null;
  declineReasonCode: string | null;
  declineNote: string | null;
  requisitionTitle: string | null;
  company: { id: string; name: string } | null;
  relation: { id: string; menteeId: string; mentee: { id: string; fullName: string } | null };
}

const PAGE_SIZE = 25;

const STATUS_VARIANT: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
  DRAFT: 'default',
  SENT: 'warning',
  ACCEPTED: 'success',
  DECLINED: 'danger',
  EXPIRED: 'default',
  WITHDRAWN: 'default',
};

// The three questions asked every morning, as URL-shareable filter sets. Each
// carries its own ordering: while a decision is pending it is how long the
// candidate has been waiting, once it is made the decision date is.
//
// "Outstanding" deliberately orders by sentAt, not expiresAt: expiresAt is
// optional and MySQL sorts NULLs first on ASC, so a deadline ordering would
// lead with the offers that have no deadline at all and bury the ones expiring
// soonest. Deadlines are what "expiring this week" is for, and that view
// excludes null ones by construction (it filters on a date range).
const PRESETS = [
  { key: 'outstanding', params: { status: 'SENT', sort: 'sentAt', dir: 'asc' } },
  { key: 'expiringThisWeek', params: { status: 'SENT', expiringWithinDays: '7', sort: 'expiresAt', dir: 'asc' } },
  { key: 'declined', params: { status: 'DECLINED', sort: 'decidedAt', dir: 'desc' } },
  { key: 'all', params: {} },
] as const;

// Everything the page may put in the query string. Listed so a preset can be
// recognised as active only when no other filter is also in play.
const FILTER_KEYS = ['status', 'expiringWithinDays', 'declineReasonCode', 'companyId', 'q', 'sort', 'dir', 'page'] as const;

function daysUntil(value: string): number {
  return Math.ceil((new Date(value).getTime() - Date.now()) / 86_400_000);
}

// /admin/offers (#1873) — the offer index. Until this existed an offer was
// reachable only through the candidate it belongs to, so "what is still out,
// what expires this week, what was declined" had no answer in the product.
// Rows link to the candidate page, where OfferManagementPanel already owns the
// per-offer detail and actions; this screen only finds them.
function OffersIndex() {
  const t = useT();
  const locale = useLocale();
  const a = t.offersAdmin;
  const router = useRouter();
  const searchParams = useSearchParams();
  const query = searchParams.toString();

  const [rows, setRows] = useState<OfferRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [companies, setCompanies] = useState<{ id: string; name: string }[]>([]);
  const [search, setSearch] = useState(searchParams.get('q') ?? '');

  const page = Math.max(1, Number(searchParams.get('page')) || 1);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const sp = new URLSearchParams(query);
    sp.set('pageSize', String(PAGE_SIZE));
    fetch(`/api/offers?${sp.toString()}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((d) => {
        if (cancelled) return;
        setRows(d.offers ?? []);
        setTotal(d.total ?? 0);
        setFailed(false);
      })
      .catch(() => { if (!cancelled) setFailed(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/companies')
      .then((res) => (res.ok ? res.json() : null))
      .then((d) => { if (!cancelled) setCompanies(d?.companies ?? []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Filters live in the URL so a view can be linked to. Changing any of them
  // drops back to page 1 — page 2 of the previous filter set means nothing.
  const setParams = useCallback((next: Record<string, string | null>) => {
    const sp = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value === null || value === '') sp.delete(key);
      else sp.set(key, value);
    }
    if (!('page' in next)) sp.delete('page');
    const qs = sp.toString();
    router.replace(qs ? `/admin/offers?${qs}` : '/admin/offers');
  }, [router, searchParams]);

  const applyPreset = useCallback((params: Record<string, string>) => {
    const qs = new URLSearchParams(params).toString();
    setSearch('');
    router.replace(qs ? `/admin/offers?${qs}` : '/admin/offers');
  }, [router]);

  const activePreset = useMemo(() => {
    const current = FILTER_KEYS.filter((key) => searchParams.get(key));
    return PRESETS.find((preset) => {
      const keys = Object.keys(preset.params);
      return current.length === keys.length && keys.every((key) => searchParams.get(key) === (preset.params as Record<string, string>)[key]);
    })?.key;
  }, [searchParams]);

  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);

  const expiry = (value: string) => {
    const days = daysUntil(value);
    if (days < 0) return <span className="text-red-600 dark:text-red-400">· {a.overdue}</span>;
    if (days === 0) return <span className="text-orange-600 dark:text-orange-400">· {a.expiresToday}</span>;
    if (days <= 7) return <span className="text-orange-600 dark:text-orange-400">· {a.expiresInDays.replace('{n}', String(days))}</span>;
    return null;
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{a.title}</h1>
        <p className="text-gray-500 mt-1 max-w-3xl">{a.subtitle}</p>
      </div>

      <div className="flex flex-wrap gap-2" data-testid="admin-offers-presets">
        {PRESETS.map((preset) => (
          <button
            key={preset.key}
            onClick={() => applyPreset(preset.params)}
            data-testid={`admin-offers-preset-${preset.key}`}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              activePreset === preset.key ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700'
            }`}
          >
            {a.presets[preset.key]}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="block text-gray-500 mb-1">{a.filters.status}</span>
          <select
            value={searchParams.get('status') ?? ''}
            onChange={(e) => setParams({ status: e.target.value })}
            data-testid="admin-offers-status"
            className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1.5 text-sm"
          >
            <option value="">{a.filters.anyStatus}</option>
            {OFFER_STATUSES.map((status) => (
              <option key={status} value={status}>{t.offers.status[status]}</option>
            ))}
          </select>
        </label>

        <label className="text-sm">
          <span className="block text-gray-500 mb-1">{a.filters.company}</span>
          <select
            value={searchParams.get('companyId') ?? ''}
            onChange={(e) => setParams({ companyId: e.target.value })}
            data-testid="admin-offers-company"
            className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1.5 text-sm"
          >
            <option value="">{a.filters.anyCompany}</option>
            {companies.map((company) => (
              <option key={company.id} value={company.id}>{company.name}</option>
            ))}
          </select>
        </label>

        <label className="text-sm">
          <span className="block text-gray-500 mb-1">{a.filters.declineReason}</span>
          <select
            value={searchParams.get('declineReasonCode') ?? ''}
            onChange={(e) => setParams({ declineReasonCode: e.target.value })}
            data-testid="admin-offers-decline-reason"
            className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1.5 text-sm"
          >
            <option value="">{a.filters.anyDeclineReason}</option>
            {DECLINE_REASON_CODES.map((code) => (
              <option key={code} value={code}>{t.offerDeclineReasons[code]}</option>
            ))}
          </select>
        </label>

        {/* data-testid, not input[type="search"]: AdminNav renders its own
            sidebar filter box with that selector on every admin page. */}
        <form
          onSubmit={(e) => { e.preventDefault(); setParams({ q: search.trim() }); }}
          className="text-sm"
        >
          <span className="block text-gray-500 mb-1">{a.filters.search}</span>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={a.filters.searchPlaceholder}
              aria-label={a.filters.searchPlaceholder}
              data-testid="admin-offers-search"
              className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 pl-8 pr-2 py-1.5 text-sm"
            />
          </div>
        </form>

        {FILTER_KEYS.some((key) => searchParams.get(key)) && (
          <button
            onClick={() => { setSearch(''); router.replace('/admin/offers'); }}
            data-testid="admin-offers-clear"
            className="text-sm text-gray-500 hover:underline py-1.5"
          >
            {a.filters.clear}
          </button>
        )}
      </div>

      {loading ? (
        <SkeletonRows rows={5} />
      ) : failed ? (
        <p className="text-sm text-red-600 dark:text-red-400">{a.loadError}</p>
      ) : rows.length === 0 ? (
        <EmptyState icon={FileSignature} title={a.emptyTitle} description={a.emptyBody} />
      ) : (
        <>
          <div className="overflow-x-auto rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
            <table className="w-full text-sm" data-testid="admin-offers-table">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-800 text-left text-gray-500">
                  <th className="px-4 py-3 font-medium">{a.columns.candidate}</th>
                  <th className="px-4 py-3 font-medium">{a.columns.company}</th>
                  <th className="px-4 py-3 font-medium">{a.columns.position}</th>
                  <th className="px-4 py-3 font-medium">{a.columns.status}</th>
                  <th className="px-4 py-3 font-medium">{a.columns.sent}</th>
                  <th className="px-4 py-3 font-medium">{a.columns.expires}</th>
                  <th className="px-4 py-3 font-medium">{a.columns.decided}</th>
                  <th className="px-4 py-3 font-medium">{a.columns.declineReason}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((offer) => (
                  <tr
                    key={offer.id}
                    data-testid={`offer-row-${offer.id}`}
                    className="border-b border-gray-100 dark:border-gray-800/60 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40"
                  >
                    <td className="px-4 py-3">
                      <Link href={`/admin/candidates/${offer.relation.menteeId}`} className="font-medium text-blue-600 hover:underline">
                        {offer.relation.mentee?.fullName ?? '—'}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{offer.company?.name ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                      {offer.position}
                      {offer.requisitionTitle && <div className="text-xs text-gray-400">{offer.requisitionTitle}</div>}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={STATUS_VARIANT[offer.status] ?? 'default'}>
                        {t.offers.status[offer.status as keyof typeof t.offers.status] ?? offer.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{offer.sentAt ? formatDate(offer.sentAt, locale) : '—'}</td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                      {offer.expiresAt ? (
                        <span className="whitespace-nowrap">
                          {formatDate(offer.expiresAt, locale)}{' '}
                          {offer.status === 'SENT' && expiry(offer.expiresAt)}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{offer.decidedAt ? formatDate(offer.decidedAt, locale) : '—'}</td>
                    <td className="px-4 py-3 text-gray-500">
                      {offer.declineReasonCode
                        ? t.offerDeclineReasons[offer.declineReasonCode as keyof typeof t.offerDeclineReasons] ?? offer.declineReasonCode
                        : '—'}
                      {offer.declineNote && <div className="text-xs text-gray-400">{offer.declineNote}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-500" data-testid="admin-offers-showing">
              {a.showing.replace('{from}', String(from)).replace('{to}', String(to)).replace('{total}', String(total))}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setParams({ page: String(page - 1) })}
                disabled={page <= 1}
                data-testid="admin-offers-prev"
                className="px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200 disabled:opacity-40"
              >
                {a.prev}
              </button>
              <button
                onClick={() => setParams({ page: String(page + 1) })}
                disabled={to >= total}
                data-testid="admin-offers-next"
                className="px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200 disabled:opacity-40"
              >
                {a.next}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// Suspense boundary: the presets and every filter live in the query string, and
// useSearchParams needs one.
export default function AdminOffersPage() {
  return (
    <Suspense fallback={null}>
      <OffersIndex />
    </Suspense>
  );
}
