'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Bell, Download, Printer, X } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { LoadErrorCard } from '@/components/ui/LoadErrorCard';
import { useToast } from '@/components/ui/Toast';
import { useModalFocus } from '@/components/ui/useModalFocus';
import { useLocale, useT } from '@/i18n/client';
import { useFilterAnnouncement, resultCountMessage } from '@/hooks/useFilterAnnouncement';

// /admin/weekly-reports (#1918) — "every intern's submission status this term"
// on one screen. Every number comes from GET /api/admin/weekly-reports, i.e.
// from src/lib/weeklyReportCompliance.ts; this page only draws it.
//
// READ-ONLY on report content by design: the drill-down shows what the intern
// wrote and the mentor said, and the only action is a NUDGE — the chase-up,
// which is this week's reminder and can never double-send (the per-week
// WeeklyReportReminder claim does that, server-side).
//
// Layout rule: the week columns scroll inside their own container; the page
// itself never scrolls sideways (360px in German is the case that matters).

type WeekState = 'missing' | 'draft' | 'submitted' | 'approved' | 'changes_requested';
interface WeekCell { weekStart: string; state: WeekState; late: boolean; hoursSpent: number | null; submittedAt: string | null }
interface Named { id: string; name: string }
interface Row {
  relationId: string;
  status: 'ACTIVE' | 'COMPLETED';
  mentee: { id: string; fullName: string };
  mentor: { id: string; fullName: string };
  company: Named | null;
  cohort: Named | null;
  internshipStart: string | null;
  internshipEnd: string | null;
  expected: number;
  submitted: number;
  reviewed: number;
  missing: number;
  late: number;
  rate: number | null;
  weeks: WeekCell[];
  canRemind: boolean;
  remindedThisWeek: boolean;
}
interface RollUp { relations: number; reporting: number; behind: number; expected: number; submitted: number; missing: number; late: number; rate: number | null }
interface Facets { cohorts: Named[]; mentors: { id: string; fullName: string }[]; companies: Named[] }

// Cell colours: `-100` chips stay light in dark mode (globals.css), so the
// `-800` text on them keeps its contrast in both themes. Each state is also a
// letter, so the matrix still reads in a black-and-white print.
const CELL: Record<WeekState, { cls: string; letter: string }> = {
  approved: { cls: 'bg-green-100 text-green-800 border-green-300', letter: '✓' },
  submitted: { cls: 'bg-blue-100 text-blue-800 border-blue-300', letter: 'S' },
  changes_requested: { cls: 'bg-amber-100 text-amber-800 border-amber-300', letter: 'C' },
  draft: { cls: 'bg-gray-100 text-gray-700 border-gray-300 border-dashed', letter: 'D' },
  missing: { cls: 'bg-red-100 text-red-800 border-red-300', letter: '✕' },
};

const PAGE_SIZE = 100;

export default function AdminWeeklyReportsPage() {
  const t = useT();
  const T = t.adminWeeklyReports;
  const locale = useLocale();
  const toast = useToast();
  const [rows, setRows] = useState<Row[]>([]);
  const [rollUp, setRollUp] = useState<RollUp | null>(null);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [filters, setFilters] = useState({ cohortId: '', mentorId: '', companyId: '', status: '' });
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [openRow, setOpenRow] = useState<Row | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    const params = new URLSearchParams({ pageSize: String(PAGE_SIZE) });
    for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
    if (!facets) params.set('facets', '1');
    try {
      const res = await fetch(`/api/admin/weekly-reports?${params}`);
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      setRows(body.rows);
      setRollUp(body.rollUp);
      setTotal(body.total);
      if (body.facets) setFacets(body.facets);
      setSelected(new Set());
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
    // `facets` is read once on the first load and deliberately not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);
  useEffect(() => { load(); }, [load]);

  const dateFmt = useMemo(() => new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', timeZone: 'UTC' }), [locale]);
  const longDate = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }), [locale]);
  const pct = (rate: number | null) => (rate === null ? T.notStarted : `${Math.round(rate * 100)}%`);

  const visible = useMemo(() => {
    const q = search.trim().toLocaleLowerCase(locale);
    return q ? rows.filter((r) => r.mentee.fullName.toLocaleLowerCase(locale).includes(q)) : rows;
  }, [rows, search, locale]);

  // One column per calendar week that any listed intern owes, oldest first.
  const weekColumns = useMemo(
    () => [...new Set(visible.flatMap((r) => r.weeks.map((w) => w.weekStart)))].sort(),
    [visible]
  );

  const stateLabel: Record<WeekState, string> = {
    approved: T.stateApproved, submitted: T.stateSubmitted, changes_requested: T.stateChanges, draft: T.stateDraft, missing: T.stateMissing,
  };

  const summary = useMemo(() => {
    const reporting = visible.filter((r) => r.expected > 0);
    const expected = reporting.reduce((n, r) => n + r.expected, 0);
    const submitted = reporting.reduce((n, r) => n + r.submitted, 0);
    return {
      interns: visible.length,
      rate: expected === 0 ? null : submitted / expected,
      compliant: reporting.filter((r) => r.missing === 0).length,
      behindTwo: visible.filter((r) => r.missing >= 2).length,
    };
  }, [visible]);

  const remindable = visible.filter((r) => r.canRemind && r.missing > 0 && !r.remindedThisWeek);
  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const remind = async () => {
    if (selected.size === 0) return;
    setSending(true);
    try {
      const res = await fetch('/api/admin/weekly-reports/remind', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relationIds: [...selected] }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const body: { reminded: string[]; skipped: string[] } = await res.json();
      const sent = T.remindedCount.replace('{count}', String(body.reminded.length));
      toast(body.skipped.length > 0 ? `${sent} ${T.skippedCount.replace('{count}', String(body.skipped.length))}` : sent, 'success');
      await load();
    } catch {
      toast(T.remindFailed, 'error');
    } finally {
      setSending(false);
    }
  };

  const exportXlsx = async () => {
    const { exportXlsxSheets } = await import('@/lib/excel');
    const head = [T.intern, T.mentor, T.company, T.cohort, T.expected, T.submitted, T.missing, T.late, T.rateCol];
    await exportXlsxSheets(`weekly-reports-${new Date().toISOString().slice(0, 10)}`, [
      {
        name: T.sheetMatrix,
        columns: [...head, ...weekColumns.map((w) => longDate.format(new Date(w)))],
        rows: visible.map((r) => {
          const byWeek = new Map(r.weeks.map((w) => [w.weekStart, w]));
          return [
            r.mentee.fullName, r.mentor.fullName, r.company?.name ?? '', r.cohort?.name ?? '',
            r.expected, r.submitted, r.missing, r.late, r.rate === null ? '' : Math.round(r.rate * 100) / 100,
            ...weekColumns.map((w) => {
              const cell = byWeek.get(w);
              return cell ? `${stateLabel[cell.state]}${cell.late ? ` (${T.late})` : ''}` : '';
            }),
          ];
        }),
      },
      {
        name: T.sheetDetail,
        columns: [T.intern, T.mentor, T.company, T.colWeek, T.colState, T.late, T.colSubmittedAt, T.colHours],
        rows: visible.flatMap((r) => r.weeks.map((w) => [
          r.mentee.fullName, r.mentor.fullName, r.company?.name ?? '', longDate.format(new Date(w.weekStart)),
          stateLabel[w.state], w.late ? T.yes : '', w.submittedAt ? new Date(w.submittedAt).toISOString().replace('T', ' ').slice(0, 16) : '', w.hoursSpent,
        ])),
      },
    ]);
  };

  const option = (items: { id: string; label: string }[]) => [{ value: '', label: T.all }, ...items.map((i) => ({ value: i.id, label: i.label }))];

  // WCAG 4.1.3 (#2864): the list is rewritten in place without moving focus,
  // so the new result count is spoken (debounced) while a filter is active.
  useFilterAnnouncement(!loading && search.trim() !== '' ? resultCountMessage(t.a11y, visible.length) : null);

  return (
    <div className="space-y-6" id="weekly-reports-print">
      {/* A4 landscape for the matrix; the sidebar and header are already hidden in print (globals.css). */}
      <style>{'@media print { @page { size: A4 landscape; margin: 10mm; } #weekly-reports-print { font-size: 10px; } }'}</style>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-900">{T.title}</h1>
          <p className="mt-1 text-sm text-gray-600">{T.subtitle}</p>
        </div>
        <div className="no-print flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={exportXlsx} disabled={visible.length === 0} data-testid="weekly-reports-export">
            <Download className="h-4 w-4" /> {T.export}
          </Button>
          <Button variant="outline" size="sm" onClick={() => window.print()} data-testid="weekly-reports-print">
            <Printer className="h-4 w-4" /> {T.print}
          </Button>
        </div>
      </div>

      <Card className="no-print">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="block lg:col-span-1">
            <span className="mb-1 block text-sm font-medium text-gray-700">{T.search}</span>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={T.search}
              data-testid="weekly-reports-search"
              className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <Select label={T.cohort} value={filters.cohortId} onChange={(e) => setFilters({ ...filters, cohortId: e.target.value })}
            options={option((facets?.cohorts ?? []).map((c) => ({ id: c.id, label: c.name })))} data-testid="weekly-reports-cohort" />
          <Select label={T.mentor} value={filters.mentorId} onChange={(e) => setFilters({ ...filters, mentorId: e.target.value })}
            options={option((facets?.mentors ?? []).map((m) => ({ id: m.id, label: m.fullName })))} data-testid="weekly-reports-mentor" />
          <Select label={T.company} value={filters.companyId} onChange={(e) => setFilters({ ...filters, companyId: e.target.value })}
            options={option((facets?.companies ?? []).map((c) => ({ id: c.id, label: c.name })))} data-testid="weekly-reports-company" />
          <Select label={T.status} value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}
            options={[{ value: '', label: T.all }, { value: 'ACTIVE', label: T.statusActive }, { value: 'COMPLETED', label: T.statusCompleted }]} data-testid="weekly-reports-status" />
        </div>
      </Card>

      {/* Summary band. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="weekly-reports-summary">
        {[
          { label: T.interns, value: String(summary.interns), id: 'interns' },
          { label: T.rate, value: pct(summary.rate), id: 'rate' },
          { label: T.compliant, value: String(summary.compliant), id: 'compliant' },
          { label: T.behindTwo, value: String(summary.behindTwo), id: 'behind-two' },
        ].map((s) => (
          <Card key={s.id} padding="sm">
            <p className="text-xs font-medium text-gray-500">{s.label}</p>
            <p className="mt-1 text-2xl font-bold text-gray-900" data-testid={`weekly-reports-summary-${s.id}`}>{s.value}</p>
          </Card>
        ))}
      </div>
      {!loading && total > rows.length && !rollUp && <p className="text-sm text-amber-700">{T.rollUpTooLarge}</p>}

      {/* Legend. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-gray-700" data-testid="weekly-reports-legend">
        <span className="font-semibold">{T.legend}:</span>
        {(Object.keys(CELL) as WeekState[]).map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5">
            <span className={`inline-flex h-5 w-5 items-center justify-center rounded border text-[10px] font-bold ${CELL[s].cls}`} aria-hidden>{CELL[s].letter}</span>
            {stateLabel[s]}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded border border-gray-300 text-[10px] font-bold ring-2 ring-red-500 ring-offset-1" aria-hidden>!</span>
          {T.stateLate}
        </span>
      </div>

      {/* Chase-up bar. */}
      <div className="no-print flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-gray-500">{T.remindHint}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={remindable.length === 0} onClick={() => setSelected(new Set(remindable.map((r) => r.relationId)))} data-testid="weekly-reports-select-behind">
            {T.selectBehind}
          </Button>
          <Button size="sm" disabled={selected.size === 0 || sending} onClick={remind} data-testid="weekly-reports-remind">
            <Bell className="h-4 w-4" /> {T.remind.replace('{count}', String(selected.size))}
          </Button>
        </div>
      </div>

      {failed ? (
        <LoadErrorCard onRetry={load} />
      ) : loading ? (
        <SkeletonRows rows={6} />
      ) : rows.length === 0 ? (
        <Card><p className="text-sm text-gray-600" data-testid="weekly-reports-empty">{Object.values(filters).some(Boolean) ? T.empty : T.noInterns}</p></Card>
      ) : (
        // The page never scrolls sideways — the matrix does, in here.
        // `relative`: the cells' sr-only labels are absolutely positioned, and
        // without a positioned ancestor they escape this scroller and widen
        // the document itself.
        <div className="relative max-w-full overflow-x-auto rounded-xl border border-gray-200 bg-white print:overflow-visible" data-testid="weekly-reports-matrix">
          <table className="min-w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs font-semibold text-gray-600">
                <th className="no-print w-8 px-2 py-2"><span className="sr-only">{T.selectBehind}</span></th>
                <th className="sticky left-0 z-10 min-w-[11rem] bg-gray-50 px-3 py-2">{T.intern}</th>
                <th className="px-2 py-2 text-right">{T.rateCol}</th>
                <th className="px-2 py-2 text-right">{T.missing}</th>
                <th className="px-2 py-2 text-right">{T.late}</th>
                {weekColumns.map((w) => (
                  <th key={w} className="px-1 py-2 text-center font-medium" title={T.weekOf.replace('{date}', longDate.format(new Date(w)))}>
                    {dateFmt.format(new Date(w))}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const byWeek = new Map(r.weeks.map((w) => [w.weekStart, w]));
                const eligible = r.canRemind && !r.remindedThisWeek;
                return (
                  <tr key={r.relationId} className="border-b border-gray-100" data-testid={`weekly-reports-row-${r.relationId}`}>
                    <td className="no-print px-2 py-2 align-top">
                      {eligible && (
                        <input
                          type="checkbox"
                          checked={selected.has(r.relationId)}
                          onChange={() => toggle(r.relationId)}
                          aria-label={T.selectRow.replace('{name}', r.mentee.fullName)}
                          data-testid={`weekly-reports-select-${r.relationId}`}
                          className="h-4 w-4"
                        />
                      )}
                    </td>
                    <td className="sticky left-0 z-10 min-w-[11rem] bg-white px-3 py-2 align-top">
                      <button type="button" onClick={() => setOpenRow(r)} className="text-left font-medium text-blue-600 hover:underline" data-testid={`weekly-reports-open-${r.relationId}`}>
                        {r.mentee.fullName}
                      </button>
                      <p className="text-xs text-gray-500">{r.mentor.fullName}{r.company ? ` · ${r.company.name}` : ''}</p>
                      {r.remindedThisWeek && (
                        <span className="mt-1 inline-flex whitespace-nowrap rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-700" data-testid={`weekly-reports-reminded-${r.relationId}`}>
                          {T.remindedBadge}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-right align-top tabular-nums" data-testid={`weekly-reports-rate-${r.relationId}`}>{pct(r.rate)}</td>
                    <td className="px-2 py-2 text-right align-top tabular-nums">{r.missing}</td>
                    <td className="px-2 py-2 text-right align-top tabular-nums">{r.late}</td>
                    {weekColumns.map((w) => {
                      const cell = byWeek.get(w);
                      if (!cell) return <td key={w} className="px-1 py-2" />;
                      const label = `${T.weekOf.replace('{date}', longDate.format(new Date(w)))}: ${stateLabel[cell.state]}${cell.late ? ` · ${T.stateLate}` : ''}`;
                      return (
                        <td key={w} className="px-1 py-2 text-center">
                          <span
                            className={`inline-flex h-6 w-6 items-center justify-center rounded border text-[11px] font-bold ${CELL[cell.state].cls} ${cell.late ? 'ring-2 ring-red-500 ring-offset-1' : ''}`}
                            title={label}
                            data-state={cell.state}
                            data-late={cell.late ? 'true' : undefined}
                          >
                            <span aria-hidden>{CELL[cell.state].letter}</span>
                            <span className="sr-only">{label}</span>
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {openRow && <DetailPanel row={openRow} onClose={() => setOpenRow(null)} />}
    </div>
  );
}

interface DetailReport {
  id: string;
  weekStart: string;
  status: string;
  summary: string;
  blockers: string | null;
  hoursSpent: number | null;
  mentorComment: string | null;
  submittedAt: string | null;
}
interface Detail {
  internshipStart: string | null;
  internshipEnd: string | null;
  weeks: { weekStart: string; state: WeekState; late: boolean; report: DetailReport | null }[];
  otherReports: DetailReport[];
}

/** The week-by-week drill-down for one intern. Read-only: there is no input in here on purpose. */
function DetailPanel({ row, onClose }: { row: Row; onClose: () => void }) {
  const t = useT();
  const T = t.adminWeeklyReports;
  const locale = useLocale();
  const ref = useModalFocus<HTMLDivElement>(true, onClose);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [failed, setFailed] = useState(false);
  const longDate = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' });
  const stateLabel: Record<WeekState, string> = {
    approved: T.stateApproved, submitted: T.stateSubmitted, changes_requested: T.stateChanges, draft: T.stateDraft, missing: T.stateMissing,
  };

  useEffect(() => {
    let live = true;
    fetch(`/api/admin/weekly-reports/${row.relationId}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
      .then((body) => { if (live) setDetail(body); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [row.relationId]);

  const report = (r: DetailReport) => (
    <div className="mt-2 space-y-1 text-sm text-gray-700">
      <p className="whitespace-pre-wrap">{r.summary}</p>
      {r.hoursSpent !== null && <p className="text-xs text-gray-500">{T.hours}: {r.hoursSpent}</p>}
      {r.blockers && <p className="whitespace-pre-wrap text-xs"><strong>{T.blockers}:</strong> {r.blockers}</p>}
      {r.mentorComment && <p className="whitespace-pre-wrap text-xs"><strong>{T.mentorComment}:</strong> {r.mentorComment}</p>}
    </div>
  );

  return (
    <div className="no-print fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="weekly-report-detail-title"
        className="h-full w-full max-w-xl overflow-y-auto bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        data-testid="weekly-reports-detail"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="weekly-report-detail-title" className="text-lg font-semibold text-gray-900">{T.detailTitle.replace('{name}', row.mentee.fullName)}</h2>
          <button type="button" onClick={onClose} className="rounded p-1 text-gray-500 hover:bg-gray-100" aria-label={T.close}>
            <X className="h-5 w-5" />
          </button>
        </div>
        {detail?.internshipStart && (
          <p className="mt-1 text-sm text-gray-600">
            {T.period
              .replace('{start}', longDate.format(new Date(detail.internshipStart)))
              .replace('{end}', detail.internshipEnd ? longDate.format(new Date(detail.internshipEnd)) : T.ongoing)}
          </p>
        )}
        <p className="mt-2 text-xs text-gray-500">{T.readOnly}</p>
        <Link
          href={`/weekly-reports/booklet/${row.relationId}`}
          target="_blank"
          className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:underline"
          data-testid="weekly-reports-booklet-link"
        >
          <Printer className="h-4 w-4" /> {T.booklet}
        </Link>

        {failed ? (
          <p className="mt-6 text-sm text-red-700">{T.error}</p>
        ) : !detail ? (
          <p className="mt-6 text-sm text-gray-500">{T.loading}</p>
        ) : (
          <ol className="mt-5 space-y-4">
            {detail.weeks.length === 0 && <li className="text-sm text-gray-500">{T.noWeeks}</li>}
            {detail.weeks.map((w) => (
              <li key={w.weekStart} className="rounded-lg border border-gray-200 p-3" data-testid="weekly-reports-detail-week">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`inline-flex h-6 w-6 items-center justify-center rounded border text-[11px] font-bold ${CELL[w.state].cls}`} aria-hidden>{CELL[w.state].letter}</span>
                  <span className="text-sm font-medium text-gray-900">{T.weekOf.replace('{date}', longDate.format(new Date(w.weekStart)))}</span>
                  <span className="text-xs text-gray-600">{stateLabel[w.state]}</span>
                  {w.late && <span className="text-xs font-semibold text-red-700">{T.stateLate}</span>}
                </div>
                {w.report && w.state !== 'draft' ? report(w.report) : <p className="mt-2 text-sm text-gray-500">{T.notHandedIn}</p>}
              </li>
            ))}
            {detail.otherReports.length > 0 && (
              <li>
                <h3 className="text-sm font-semibold text-gray-700">{T.otherReports}</h3>
                {detail.otherReports.map((r) => (
                  <div key={r.id} className="mt-2 rounded-lg border border-dashed border-gray-300 p-3">
                    <p className="text-sm font-medium text-gray-900">{T.weekOf.replace('{date}', longDate.format(new Date(r.weekStart)))}</p>
                    {report(r)}
                  </div>
                ))}
              </li>
            )}
          </ol>
        )}
      </div>
    </div>
  );
}
