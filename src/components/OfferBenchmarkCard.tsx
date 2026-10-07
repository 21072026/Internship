'use client';

import { useEffect, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { useT, useLocale } from '@/i18n/client';
import { formatMinorAmount } from '@/lib/money';
import type { BenchmarkBucket } from '@/lib/compensation';

interface BenchmarkResponse {
  buckets: BenchmarkBucket[];
  minBucket: number;
  by: 'contractType' | null;
  measured: number;
  scanned: number;
}

// The offer benchmark on /admin/offers (#1851): one row per position × currency
// (× contract type when split), median / p25 / p75 of the monthly base of
// ACCEPTED offers. Collapsed by default — it is a read model, not the index —
// and fetched only when opened. A suppressed bucket is shown as a row that
// says why, never dropped: "we have three offers for this title" is itself an
// answer, and a silently missing row looks like a missing feature.
export function OfferBenchmarkCard() {
  const t = useT();
  const locale = useLocale();
  const b = t.offersAdmin.benchmark;
  const [open, setOpen] = useState(false);
  const [byContractType, setByContractType] = useState(false);
  const [data, setData] = useState<BenchmarkResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setData(null);
    setFailed(false);
    fetch(`/api/admin/offers/benchmark${byContractType ? '?by=contractType' : ''}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((d: BenchmarkResponse) => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [open, byContractType]);

  const minBucket = data?.minBucket ?? 5;
  const money = (minor: number | null, currency: string) => (minor == null ? '—' : formatMinorAmount(minor, currency, locale));

  return (
    <section className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4" data-testid="offer-benchmark-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-gray-400" />
          <h2 className="font-semibold text-gray-900 dark:text-gray-100">{b.title}</h2>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          data-testid="offer-benchmark-toggle"
          className="text-sm text-blue-600 hover:underline"
          aria-expanded={open}
        >
          {open ? b.hide : b.show}
        </button>
      </div>
      {open && (
        <div className="mt-3 space-y-3">
          <p className="text-sm text-gray-500 max-w-3xl">{b.subtitle.replace('{n}', String(minBucket))}</p>
          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input type="checkbox" checked={byContractType} onChange={(e) => setByContractType(e.target.checked)} data-testid="offer-benchmark-by-contract" />
            {b.byContractType}
          </label>
          {failed ? (
            <p className="text-sm text-red-600 dark:text-red-400">{b.loadError}</p>
          ) : !data ? (
            <p className="text-sm text-gray-400">{t.common.loading}</p>
          ) : data.buckets.length === 0 ? (
            <p className="text-sm text-gray-500" data-testid="offer-benchmark-empty">{b.empty}</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="offer-benchmark-table">
                  <thead>
                    <tr className="border-b border-gray-200 dark:border-gray-800 text-left text-gray-500">
                      <th className="px-3 py-2 font-medium">{b.columns.position}</th>
                      <th className="px-3 py-2 font-medium">{b.columns.currency}</th>
                      {data.by === 'contractType' && <th className="px-3 py-2 font-medium">{b.columns.contractType}</th>}
                      <th className="px-3 py-2 font-medium text-right">{b.columns.count}</th>
                      <th className="px-3 py-2 font-medium text-right">{b.columns.p25}</th>
                      <th className="px-3 py-2 font-medium text-right">{b.columns.median}</th>
                      <th className="px-3 py-2 font-medium text-right">{b.columns.p75}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.buckets.map((bucket) => (
                      <tr
                        key={`${bucket.position}|${bucket.currency}|${bucket.contractType ?? ''}`}
                        data-testid={`offer-benchmark-row-${bucket.position.replace(/\s+/g, '-')}-${bucket.currency}`}
                        className="border-b border-gray-100 dark:border-gray-800/60 last:border-0"
                      >
                        <td className="px-3 py-2 capitalize text-gray-900 dark:text-gray-100">{bucket.position}</td>
                        <td className="px-3 py-2">{bucket.currency}</td>
                        {data.by === 'contractType' && (
                          <td className="px-3 py-2">
                            {bucket.contractType ? (t.offers.compensation.contractTypes as Record<string, string>)[bucket.contractType] ?? bucket.contractType : '—'}
                          </td>
                        )}
                        <td className="px-3 py-2 text-right">{bucket.count}</td>
                        {bucket.suppressed ? (
                          <td className="px-3 py-2 text-right text-gray-400 italic" colSpan={3} data-testid="offer-benchmark-suppressed">
                            {b.suppressed.replace('{n}', String(minBucket))}
                          </td>
                        ) : (
                          <>
                            <td className="px-3 py-2 text-right">{money(bucket.p25MonthlyMinor, bucket.currency)}</td>
                            <td className="px-3 py-2 text-right font-medium">{money(bucket.medianMonthlyMinor, bucket.currency)}</td>
                            <td className="px-3 py-2 text-right">{money(bucket.p75MonthlyMinor, bucket.currency)}</td>
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-gray-400">
                {b.measured.replace('{measured}', String(data.measured)).replace('{scanned}', String(data.scanned))}
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
