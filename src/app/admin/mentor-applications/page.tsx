'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useT, useLocale } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';
import { isRejectReasonAmbiguous } from '@/lib/mentorApplicationRejectReason';

interface ApplicationRow {
  id: string;
  fullName: string;
  email: string;
  expertise: string[];
  capacity: number | null;
  status: 'PENDING' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED';
  createdAt: string;
  decidedAt: string | null;
  // Two separate admin-only free-text fields (#1806): the reason a rejection
  // was decided, and a private review note. They used to share one column, so
  // saving a note wiped the reason.
  rejectReason: string | null;
  adminNote: string | null;
}

const STATUS_TABS = ['PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'ALL'] as const;
const STATUS_VARIANT: Record<string, 'warning' | 'info' | 'success' | 'danger'> = {
  PENDING: 'warning',
  UNDER_REVIEW: 'info',
  APPROVED: 'success',
  REJECTED: 'danger',
};

export default function MentorApplicationsPage() {
  const t = useT();
  const locale = useLocale();
  const a = t.mentorApplicationsAdmin;
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_TABS)[number]>('PENDING');
  const [rows, setRows] = useState<ApplicationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    const qs = statusFilter === 'ALL' ? '' : `?status=${statusFilter}`;
    fetch(`/api/mentor-applications${qs}`)
      .then((res) => (res.ok ? res.json() : { items: [] }))
      .then((d) => setRows(d.items ?? []))
      .finally(() => setLoading(false));
  }, [statusFilter]);

  useEffect(() => { load(); }, [load]);

  const statusLabel = (s: string) =>
    ({ PENDING: a.statusPending, UNDER_REVIEW: a.statusUnderReview, APPROVED: a.statusApproved, REJECTED: a.statusRejected, ALL: a.statusAll } as Record<string, string>)[s] ?? s;

  const q = search.trim().toLowerCase();
  const shown = rows.filter(
    (r) =>
      !q ||
      r.fullName.toLowerCase().includes(q) ||
      r.email.toLowerCase().includes(q) ||
      (r.expertise ?? []).some((s) => s.toLowerCase().includes(q))
  );

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{a.title}</h1>
        <p className="text-gray-500 mt-1">{a.subtitle}</p>
      </div>

      <input
        type="search"
        data-testid="mentor-applications-search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={a.searchPlaceholder}
        className="mb-4 w-full sm:w-80 rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
      />

      <div className="flex flex-wrap gap-2 mb-4">
        {STATUS_TABS.map((s) => (
          <button
            key={s}
            type="button"
            data-testid={`mentor-applications-tab-${s.toLowerCase()}`}
            onClick={() => setStatusFilter(s)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              statusFilter === s
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
            }`}
          >
            {statusLabel(s)}
          </button>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{a.title} ({shown.length})</CardTitle>
        </CardHeader>

        {loading ? (
          <SkeletonRows rows={6} />
        ) : shown.length === 0 ? (
          <p className="text-center py-12 text-gray-400">{a.none}</p>
        ) : (
          <div className="divide-y divide-gray-50 dark:divide-gray-800">
            {shown.map((r) => (
              <div key={r.id} data-testid={`mentor-application-${r.id}`} className="flex items-start justify-between gap-3 py-3">
                <div className="flex items-start gap-3 min-w-0">
                  <div className="w-9 h-9 bg-blue-100 dark:bg-blue-900/40 rounded-full flex items-center justify-center flex-shrink-0">
                    <span className="text-blue-700 dark:text-blue-300 font-semibold text-sm">{r.fullName?.[0] || 'M'}</span>
                  </div>
                  <div className="min-w-0">
                    <Link href={`/admin/mentor-applications/${r.id}`} className="text-sm font-medium text-gray-900 dark:text-gray-100 hover:text-blue-600 truncate block">
                      {r.fullName}
                    </Link>
                    <p className="text-xs text-gray-500 truncate">
                      {r.email} · {a.appliedOn.replace('{date}', formatDate(r.createdAt, locale))}
                    </p>
                    {r.expertise && r.expertise.length > 0 ? (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {r.expertise.map((s) => (
                          <span key={s} className="inline-flex rounded-full bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-2 py-0.5 text-[11px]">
                            {s}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-1.5 text-[11px] text-gray-400">{a.noSkills}</p>
                    )}
                    {/* Only a REJECTED row shows a rejection reason — see the
                        note on the detail page: a value on any other status is
                        a pre-#1806 note the old code mis-filed. A row decided
                        before the split gets the hedged label instead, because
                        its text may equally be the note that replaced the
                        reason. */}
                    {r.status === 'REJECTED' && r.rejectReason ? (
                      <p className="mt-1.5 text-[11px] text-gray-500 line-clamp-2" data-testid={`mentor-application-reason-${r.id}`}>
                        <span className="font-medium">
                          {`${isRejectReasonAmbiguous(r.status, r.decidedAt) ? a.rejectReasonRecordedUnverified : a.rejectReasonLabel}:`}
                        </span>{' '}
                        {r.rejectReason}
                      </p>
                    ) : null}
                    {r.adminNote ? (
                      <p className="mt-1 text-[11px] text-gray-500 line-clamp-2" data-testid={`mentor-application-note-${r.id}`}>
                        <span className="inline-flex rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200 mr-1">
                          {a.internalBadge}
                        </span>
                        {r.adminNote}
                      </p>
                    ) : null}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-2 flex-shrink-0">
                  <Badge variant={STATUS_VARIANT[r.status] ?? 'default'}>{statusLabel(r.status)}</Badge>
                  {r.capacity != null && (
                    <span className="text-xs text-gray-500">{a.capacityLabel}: {r.capacity}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
