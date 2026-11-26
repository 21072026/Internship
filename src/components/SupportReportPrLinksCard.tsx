'use client';

import { useState } from 'react';
import { ExternalLink, GitPullRequest, X } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';
import { readPrLinks, type SupportPrLink } from '@/lib/supportReportPrLinks';

// The PRs a report was worked in (#3928), on the admin's report page only:
// typed in by hand, removed by hand. The reporter never sees them — their own
// list, mail and bell do not carry the column. The write is
// POST/DELETE /api/admin/support/reports/[id]/pr-links.
export function SupportReportPrLinksCard({ reportId, initial }: { reportId: string; initial: unknown }) {
  const t = useT();
  const a = t.adminReports;
  const [links, setLinks] = useState<SupportPrLink[]>(() => readPrLinks(initial));
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const call = async (method: 'POST' | 'DELETE', body: unknown) => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/support/reports/${reportId}/pr-links`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const codes: Record<string, string> = {
          invalid_pr_url: a.prErrorInvalidUrl,
          wrong_repo: a.prErrorWrongRepo,
          too_many: a.prErrorTooMany,
          conflict: a.prErrorConflict,
        };
        setError(codes[data.code] ?? t.common.error);
        return false;
      }
      setLinks(readPrLinks(data.prLinks));
      return true;
    } catch {
      setError(t.common.error);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mt-4" data-testid="report-pr-links">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
        <GitPullRequest className="h-4 w-4" aria-hidden="true" /> {a.prTitle}
      </h2>
      <p className="mb-3 text-xs text-gray-600 dark:text-gray-400">{a.prHint}</p>
      {links.length === 0 ? (
        <p className="mb-3 text-sm text-gray-500" data-testid="report-pr-empty">{a.prNone}</p>
      ) : (
        <ul className="mb-3 space-y-1" data-testid="report-pr-list">
          {links.map((l) => (
            <li key={l.number} className="flex items-center gap-2 text-sm">
              <a href={l.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:underline dark:text-blue-400" data-testid={`report-pr-${l.number}`}>
                #{l.number} <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
              <button
                type="button"
                disabled={busy}
                onClick={() => call('DELETE', { number: l.number })}
                aria-label={a.prRemove.replace('{n}', String(l.number))}
                className="rounded p-1 text-gray-400 hover:text-red-600"
                data-testid={`report-pr-remove-${l.number}`}
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (url.trim() && (await call('POST', { url: url.trim() }))) setUrl('');
        }}
      >
        <div className="min-w-0 flex-1">
          <Input
            id={`report-pr-url-${reportId}`}
            label={a.prUrlLabel}
            placeholder="https://github.com/21072026/Internship/pull/1234"
            value={url}
            disabled={busy}
            onChange={(e) => setUrl(e.target.value)}
            data-testid="report-pr-url"
          />
        </div>
        <Button type="submit" size="sm" loading={busy} disabled={!url.trim()} data-testid="report-pr-add">
          {a.prAdd}
        </Button>
      </form>
      {error && <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400" data-testid="report-pr-error">{error}</p>}
    </Card>
  );
}
