'use client';

import { useEffect, useState } from 'react';
import { Puzzle } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { useT } from '@/i18n/client';

interface GapRow {
  skillId: string;
  label: string;
  holders: number;
  avgLevel: number | null;
  confirmed: number;
  demandRequisitions: number;
  demandOpenings: number;
  gap: number;
}

interface GapReport {
  underSupplied: GapRow[];
  unused: GapRow[];
  coverage: { covered: number; total: number; share: number | null };
  hiringRequisitions: number;
  requisitionsWithoutSkills: number;
  supplyPeople: number;
}

// The skills-gap report (#1823) on /admin/analytics: supply (what the pool
// holds) against demand (what hiring positions require), two ranked lists,
// coverage, a cohort filter and the export. Every number is the route's
// (`/api/admin/analytics/skills-gap`, rules in src/lib/skillsGapRule.ts) —
// this card only draws them, and says WHY when there is nothing to draw.
//
// Mounted only for a premium tenant, like CohortComparison; the route re-checks
// the entitlement, and the export route re-checks REPORT_EXPORT.
export function SkillsGapPanel({ canExport }: { canExport: boolean }) {
  const t = useT();
  const g = t.skillsGap;
  const [cohorts, setCohorts] = useState<{ id: string; name: string }[]>([]);
  const [cohortId, setCohortId] = useState('');
  const [report, setReport] = useState<GapReport | null>(null);
  const [exportFailed, setExportFailed] = useState(false);

  useEffect(() => {
    fetch('/api/cohorts')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setCohorts(d?.cohorts ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    const q = cohortId ? `?cohortId=${encodeURIComponent(cohortId)}` : '';
    fetch(`/api/admin/analytics/skills-gap${q}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) setReport(d); })
      .catch(() => {});
    return () => { alive = false; };
  }, [cohortId]);

  const exportFile = async () => {
    setExportFailed(false);
    const q = cohortId ? `?cohortId=${encodeURIComponent(cohortId)}` : '';
    const res = await fetch(`/api/admin/export/skills-gap${q}`);
    if (!res.ok) return setExportFailed(true);
    const { sheets } = await res.json();
    const { exportXlsxSheets } = await import('@/lib/excel');
    await exportXlsxSheets(`skills-gap-${new Date().toISOString().slice(0, 10)}`, sheets);
  };

  if (!report) return null;
  const noDemand = report.coverage.total === 0;
  const noSupply = report.supplyPeople === 0;

  const table = (rows: GapRow[], testId: string) => (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-testid={testId}>
        <thead>
          <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800">
            <th className="py-2 pr-3">{g.colSkill}</th>
            <th className="py-2 pr-3">{g.colSeats}</th>
            <th className="py-2 pr-3">{g.colPositions}</th>
            <th className="py-2 pr-3">{g.colPeople}</th>
            <th className="py-2 pr-3">{g.colGap}</th>
            <th className="py-2 pr-3">{g.colAvgLevel}</th>
            <th className="py-2">{g.colConfirmed}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
          {rows.map((r) => (
            <tr key={r.skillId}>
              <td className="py-2 pr-3 font-medium text-gray-900 dark:text-gray-100">{r.label}</td>
              <td className="py-2 pr-3">{r.demandOpenings}</td>
              <td className="py-2 pr-3">{r.demandRequisitions}</td>
              <td className="py-2 pr-3">
                <span className="inline-flex items-center gap-2">
                  {r.holders}
                  {/* Supply against demand as one bar pair, no chart library. */}
                  <span className="hidden sm:inline-flex h-1.5 w-20 overflow-hidden rounded bg-gray-100 dark:bg-gray-800" aria-hidden>
                    <span
                      className="bg-blue-500"
                      style={{ width: `${Math.min(100, (r.holders / Math.max(r.holders, r.demandOpenings, 1)) * 100)}%` }}
                    />
                  </span>
                </span>
              </td>
              <td className={`py-2 pr-3 font-semibold ${r.gap > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-700 dark:text-gray-300'}`}>
                {r.gap > 0 ? `+${r.gap}` : r.gap}
              </td>
              <td className="py-2 pr-3">{r.avgLevel ?? '—'}</td>
              <td className="py-2">{r.confirmed}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <Card className="mt-6" data-testid="skills-gap">
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Puzzle className="h-5 w-5 text-blue-600" aria-hidden />
            <CardTitle>{g.title}</CardTitle>
          </div>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{g.subtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 no-print">
          {cohorts.length > 0 && (
            <Select
              aria-label={g.cohortLabel}
              className="w-auto"
              value={cohortId}
              onChange={(e) => setCohortId(e.target.value)}
              data-testid="skills-gap-cohort"
              options={[{ value: '', label: g.cohortAll }, ...cohorts.map((c) => ({ value: c.id, label: c.name }))]}
            />
          )}
          {canExport && (
            <Button size="sm" variant="outline" onClick={exportFile} data-testid="skills-gap-export">
              {g.export}
            </Button>
          )}
        </div>
      </CardHeader>

      {exportFailed && <p className="mb-3 text-sm text-red-600 dark:text-red-400">{t.common.exportLocked}</p>}

      {noDemand || noSupply ? (
        <p className="py-4 text-sm text-gray-500 dark:text-gray-400" data-testid="skills-gap-empty">
          {noDemand ? g.emptyNoPositions : g.emptyNoSkills}
        </p>
      ) : (
        <>
          <p className="mb-4 text-sm text-gray-700 dark:text-gray-300" data-testid="skills-gap-coverage">
            {g.coverage.replace('{covered}', String(report.coverage.covered)).replace('{total}', String(report.coverage.total))}
          </p>
          <h3 className="mb-1 text-sm font-semibold text-gray-900 dark:text-gray-100">{g.underTitle}</h3>
          {report.underSupplied.length > 0 ? table(report.underSupplied, 'skills-gap-under') : (
            <p className="py-2 text-sm text-gray-500 dark:text-gray-400">{g.noneUnder}</p>
          )}
          {report.unused.length > 0 && (
            <>
              <h3 className="mt-5 mb-1 text-sm font-semibold text-gray-900 dark:text-gray-100">{g.unusedTitle}</h3>
              {table(report.unused, 'skills-gap-unused')}
            </>
          )}
        </>
      )}
      {report.requisitionsWithoutSkills > 0 && (
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
          {g.withoutSkills.replace('{n}', String(report.requisitionsWithoutSkills))}
        </p>
      )}
      <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">{g.footnote}</p>
    </Card>
  );
}
