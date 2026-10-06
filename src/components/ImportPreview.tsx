'use client';

import { useT } from '@/i18n/client';
import type { RowStatus } from '@/lib/importPreview';

// The one preview every importer draws (#2072): the counts, then one line per
// row with its verdict, why, and — for an UPDATE — what would change. It reads
// the engine's shared report shape (src/lib/importPreview.ts), so a preview
// and a finished run look the same and differ only in the note above them.
//
// Reasons arrive as the engine's English tokens ("already exists", "fullName
// too long (max 191)"); the known ones are translated here, anything else is
// shown as sent rather than hidden.

export interface PreviewRow {
  row: number;
  key: string;
  status: RowStatus;
  reason?: string;
  /** An UPDATE's fields — names only, or `[from, to]` per field. */
  changed?: string[];
  changes?: Record<string, [unknown, unknown]>;
  possibleDuplicates?: { id: string; fullName: string; matchedOn: string[] }[];
}

export interface PreviewReport {
  dryRun: boolean;
  counts: Partial<Record<RowStatus, number>>;
  rows: PreviewRow[];
}

const ORDER: RowStatus[] = ['CREATE', 'UPDATE', 'UNCHANGED', 'SKIP', 'ERROR'];

// 700 on white, -400 in dark mode: the contrast rule of #2131.
const TONE: Record<RowStatus, string> = {
  CREATE: 'text-green-700 dark:text-green-400',
  UPDATE: 'text-blue-700 dark:text-blue-300',
  UNCHANGED: 'text-gray-600 dark:text-gray-300',
  SKIP: 'text-amber-700 dark:text-amber-400',
  ERROR: 'text-red-700 dark:text-red-400',
};

const KNOWN_REASONS: Record<string, string> = {
  'invalid email': 'invalidEmail',
  'email too long': 'emailTooLong',
  'already exists': 'alreadyExists',
  'duplicate in file': 'duplicateInFile',
  'could not be saved': 'couldNotSave',
  // The programme migration's (#2073).
  'invalid mentorEmail': 'invalidEmail',
  'invalid menteeEmail': 'invalidEmail',
  'unknown mentor': 'unknownMentor',
  'unknown mentee': 'unknownMentee',
  'unknown pair': 'unknownPair',
  'belongs to another organization': 'otherOrganization',
  'mentee already has an active mentorship': 'alreadyMentored',
  'date is in the future': 'futureDate',
  'startDate is in the future': 'futureDate',
  'from and to are the same stage': 'sameStage',
  'unreadable date': 'unreadableDate',
  'unreadable startDate': 'unreadableDate',
  'date missing': 'dateMissing',
  'notes missing': 'notesMissing',
  'role missing': 'roleMissing',
  'mentor and mentee are the same person': 'samePerson',
};

// Reasons that carry a value: the token's English shape → its key and the value.
const PATTERN_REASONS: [RegExp, string][] = [
  [/^unmapped stage "(.*)"$/, 'unmappedStage'],
  [/^unknown role "(.*)"$/, 'unknownRole'],
  [/^unknown type "(.*)"$/, 'unknownType'],
  [/^unknown status "(.*)"$/, 'unknownStatus'],
  [/^(?:mentor |mentee )?exists as (\w+)$/, 'existsAs'],
];

const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));

export function ImportPreview({
  report,
  maxHeight = 'max-h-72',
  reasons: extraReasons,
}: {
  report: PreviewReport;
  maxHeight?: string;
  /** Reason texts an importer brings itself (words this shared block must not carry). */
  reasons?: Record<string, string>;
}) {
  const t = useT();
  const p = t.importPreview;
  const dict: Record<string, string> = { ...(p.reasons as Record<string, string>), ...(extraReasons ?? {}) };
  const reasonText = (reason: string) => {
    const known = KNOWN_REASONS[reason];
    if (known && dict[known]) return dict[known];
    const tooLong = /^(\w+) too long \(max (\d+)\)$/.exec(reason);
    if (tooLong) return p.reasons.tooLong.replace('{field}', tooLong[1]).replace('{max}', tooLong[2]);
    for (const [re, key] of PATTERN_REASONS) {
      const m = re.exec(reason);
      if (m && dict[key]) return dict[key].replace('{value}', m[1]);
    }
    return reason;
  };

  return (
    <div className="space-y-2" data-testid="import-preview" data-dry-run={report.dryRun ? 'true' : 'false'}>
      <p className="text-xs text-gray-600 dark:text-gray-300">{report.dryRun ? p.dryRunNote : p.writtenNote}</p>
      <div className="flex flex-wrap gap-2 text-xs" data-testid="import-preview-counts">
        {ORDER.filter((s) => (report.counts[s] ?? 0) > 0 || s === 'CREATE').map((s) => (
          <span key={s} className="rounded-full border border-gray-200 px-2 py-0.5 dark:border-gray-700" data-status={s} data-count={report.counts[s] ?? 0}>
            <span className={`font-medium ${TONE[s]}`}>{p.status[s]}</span> {report.counts[s] ?? 0}
          </span>
        ))}
      </div>
      {report.rows.length > 0 && (
        <div className={`${maxHeight} overflow-y-auto rounded-lg border border-gray-100 text-xs dark:border-gray-800`}>
          <table className="w-full">
            <thead className="sticky top-0 bg-white text-left text-gray-500 dark:bg-gray-900 dark:text-gray-400">
              <tr>
                <th className="px-2 py-1 font-medium">{p.columns.row}</th>
                <th className="px-2 py-1 font-medium">{p.columns.status}</th>
                <th className="px-2 py-1 font-medium">{p.columns.key}</th>
                <th className="px-2 py-1 font-medium">{p.columns.detail}</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((r) => (
                <tr key={`${r.row}-${r.key}`} data-testid={`import-preview-row-${r.row}`} data-status={r.status} className="border-t border-gray-50 align-top dark:border-gray-800">
                  <td className="px-2 py-1 text-gray-400">{r.row}</td>
                  <td className={`whitespace-nowrap px-2 py-1 font-medium ${TONE[r.status]}`}>{p.status[r.status] ?? r.status}</td>
                  <td className="max-w-[12rem] truncate px-2 py-1 text-gray-700 dark:text-gray-200" title={r.key}>{r.key || '—'}</td>
                  <td className="px-2 py-1 text-gray-600 dark:text-gray-300">
                    {r.reason && <span>{reasonText(r.reason)}</span>}
                    {r.changes && Object.keys(r.changes).length > 0 && (
                      <ul className="space-y-0.5" data-testid={`import-preview-diff-${r.row}`}>
                        {Object.entries(r.changes).map(([field, [from, to]]) => (
                          <li key={field}>
                            <span className="font-medium">{field}</span>: <span className="line-through">{show(from)}</span> → {show(to)}
                          </li>
                        ))}
                      </ul>
                    )}
                    {!r.changes && r.changed && r.changed.length > 0 && <span>{p.changedFields.replace('{fields}', r.changed.join(', '))}</span>}
                    {r.possibleDuplicates && r.possibleDuplicates.length > 0 && (
                      <div className="mt-1 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-amber-800">
                        {t.duplicates.possibleDuplicatesTitle}:{' '}
                        {r.possibleDuplicates.map((d, i) => (
                          <span key={d.id}>
                            {i > 0 && '; '}
                            <span className="font-medium">{d.fullName}</span> ({t.duplicates.matchedOn}:{' '}
                            {d.matchedOn.map((sig) => t.duplicates.signals[sig as keyof typeof t.duplicates.signals] ?? sig).join(', ')})
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
