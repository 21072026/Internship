'use client';

import { useMemo, useState } from 'react';
import { Download, ShieldCheck, ShieldAlert, ShieldX } from 'lucide-react';
import { Select } from '@/components/ui/Select';
import { exportXlsx } from '@/lib/excel';
import { formatDate } from '@/lib/relativeTime';
import type { AcceptanceStatus } from '@/lib/contributorTermsReport';

export interface ReportRowDTO {
  userId: string;
  fullName: string;
  email: string;
  role: string;
  projectId: string | null;
  projectName: string | null;
  termsKey: string;
  currentVersion: string;
  acceptedVersion: string | null;
  acceptedAt: string | null;
  status: AcceptanceStatus;
  evidence: boolean;
}

const STATUS_STYLE: Record<AcceptanceStatus, string> = {
  accepted: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  outdated: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  missing: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
};
const STATUS_ICON: Record<AcceptanceStatus, typeof ShieldCheck> = {
  accepted: ShieldCheck,
  outdated: ShieldAlert,
  missing: ShieldX,
};

export function ContributorTermsReport({
  rows,
  locale,
  labels,
}: {
  rows: ReportRowDTO[];
  locale: string;
  labels: Record<string, string>;
}) {
  const [status, setStatus] = useState<'all' | AcceptanceStatus | 'open'>('all');
  const [project, setProject] = useState('all');

  const projects = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) if (r.projectId && r.projectName) seen.set(r.projectId, r.projectName);
    return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  const filtered = useMemo(
    () =>
      rows.filter((r) => {
        // "open" is the working filter: everything still owed, whether it was
        // never accepted or was accepted against wording that no longer governs.
        if (status === 'open' ? r.status === 'accepted' : status !== 'all' && r.status !== status) return false;
        if (project === 'platform' ? r.projectId !== null : project !== 'all' && r.projectId !== project) return false;
        return true;
      }),
    [rows, status, project]
  );

  const counts = useMemo(
    () => ({
      accepted: rows.filter((r) => r.status === 'accepted').length,
      outdated: rows.filter((r) => r.status === 'outdated').length,
      missing: rows.filter((r) => r.status === 'missing').length,
    }),
    [rows]
  );

  const statusLabel = (s: AcceptanceStatus) =>
    ({ accepted: labels.statusAccepted, outdated: labels.statusOutdated, missing: labels.statusMissing })[s];

  const download = () => {
    exportXlsx(
      `contributor-terms-${new Date().toISOString().slice(0, 10)}.xlsx`,
      [
        labels.colName, labels.colEmail, labels.colRole, labels.colScope, labels.colTerms,
        labels.colCurrentVersion, labels.colAcceptedVersion, labels.colAcceptedAt,
        labels.colStatus, labels.colEvidence,
      ],
      filtered.map((r) => [
        r.fullName, r.email, r.role,
        r.projectName ?? labels.scopePlatform,
        r.termsKey, r.currentVersion, r.acceptedVersion ?? '',
        r.acceptedAt ? formatDate(new Date(r.acceptedAt), locale) : '',
        statusLabel(r.status),
        // The evidence column says whether a record exists, never what it holds.
        r.evidence ? labels.evidenceRecorded : '',
      ]),
      'Contributor terms'
    );
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Select
          label={labels.filterStatus}
          data-testid="terms-report-status"
          className="min-w-[12rem]"
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
          options={[
            { value: 'all', label: labels.filterAll },
            { value: 'open', label: `${labels.filterOpen} (${counts.outdated + counts.missing})` },
            { value: 'missing', label: `${labels.statusMissing} (${counts.missing})` },
            { value: 'outdated', label: `${labels.statusOutdated} (${counts.outdated})` },
            { value: 'accepted', label: `${labels.statusAccepted} (${counts.accepted})` },
          ]} />
        <Select
          label={labels.filterProject}
          data-testid="terms-report-project"
          className="min-w-[14rem]"
          value={project}
          onChange={(e) => setProject(e.target.value)}
          options={[
            { value: 'all', label: labels.filterAll },
            { value: 'platform', label: labels.scopePlatform },
            ...projects.map((p) => ({ value: p.id, label: p.name })),
          ]} />
        <button
          type="button"
          onClick={download}
          data-testid="terms-report-export"
          disabled={filtered.length === 0}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40"
        >
          <Download className="h-4 w-4" />
          {labels.export}
        </button>
      </div>

      {filtered.length === 0 ? (
        <div
          data-testid="terms-report-empty"
          className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-10 text-center text-gray-400"
        >
          {labels.none}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
          <table className="w-full text-sm" data-testid="terms-report-table">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-800 text-left text-gray-500">
                <th className="px-4 py-3 font-medium">{labels.colName}</th>
                <th className="px-4 py-3 font-medium">{labels.colScope}</th>
                <th className="px-4 py-3 font-medium">{labels.colTerms}</th>
                <th className="px-4 py-3 font-medium">{labels.colAcceptedAt}</th>
                <th className="px-4 py-3 font-medium">{labels.colStatus}</th>
                <th className="px-4 py-3 font-medium">{labels.colEvidence}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const Icon = STATUS_ICON[r.status];
                return (
                  <tr
                    key={`${r.userId}-${r.termsKey}-${r.projectId ?? 'platform'}`}
                    data-testid={`terms-report-row-${r.userId}-${r.projectId ?? 'platform'}`}
                    className="border-b border-gray-100 dark:border-gray-800/60 last:border-0"
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900 dark:text-gray-100">{r.fullName}</div>
                      <div className="text-xs text-gray-400">{r.email}</div>
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                      {r.projectName ?? labels.scopePlatform}
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                      {r.termsKey} v{r.currentVersion}
                      {r.status === 'outdated' && (
                        <span className="ml-1 text-xs text-amber-600">({labels.acceptedVersionShort} v{r.acceptedVersion})</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                      {r.acceptedAt ? formatDate(new Date(r.acceptedAt), locale) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[r.status]}`}>
                        <Icon className="h-3.5 w-3.5" />
                        {statusLabel(r.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {r.evidence ? labels.evidenceRecorded : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
