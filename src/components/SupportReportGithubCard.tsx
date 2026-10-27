'use client';

import { useEffect, useState } from 'react';
import { ExternalLink, Github } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

// "Create GitHub issue" for one bug report (#3132). The draft comes from the
// server (public-safe by construction) and is shown in full, editable, next to
// a warning when the target repository is public — the admin sends exactly
// what they read.

interface State {
  configured: boolean;
  repo?: string;
  isPrivate?: boolean;
  issueUrl?: string | null;
  draft?: { title: string; body: string };
}

export function SupportReportGithubCard({ reportId }: { reportId: string }) {
  const t = useT();
  const a = t.adminReports;
  const [state, setState] = useState<State | null>(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    fetch(`/api/admin/support/reports/${reportId}/github`)
      .then((r) => (r.ok ? r.json() : { configured: false }))
      .then((d: State) => {
        setState(d);
        setTitle(d.draft?.title ?? '');
        setBody(d.draft?.body ?? '');
      })
      .catch(() => setState({ configured: false }));
  }, [reportId]);

  const create = async () => {
    setBusy(true);
    setErr('');
    try {
      const res = await fetch(`/api/admin/support/reports/${reportId}/github`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.issueUrl) throw new Error();
      setState((s) => (s ? { ...s, issueUrl: d.issueUrl } : s));
      setEditing(false);
    } catch {
      setErr(a.githubFailed);
    } finally {
      setBusy(false);
    }
  };

  if (!state) return null;
  const linked = state.issueUrl && !state.issueUrl.startsWith('pending:') ? state.issueUrl : null;

  return (
    <Card className="mt-4" data-testid="report-github">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
        <Github className="h-4 w-4" aria-hidden="true" /> {a.githubTitle}
      </h2>
      {linked ? (
        <a href={linked} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-blue-700 hover:underline dark:text-blue-400" data-testid="report-github-link">
          {a.githubOpen}: {linked.replace('https://github.com/', '')} <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
      ) : !state.configured ? (
        <p className="text-sm text-gray-600 dark:text-gray-400">{a.githubNotConfigured}</p>
      ) : !editing ? (
        <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)} data-testid="report-github-create">
          {a.githubCreate}
        </Button>
      ) : (
        <div className="space-y-3">
          {state.isPrivate ? (
            <p className="text-sm text-gray-700 dark:text-gray-300">{a.githubPrivate.replace('{repo}', state.repo ?? '')}</p>
          ) : (
            <p role="note" className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200" data-testid="report-github-public">
              {a.githubPublicWarning.replace('{repo}', state.repo ?? '')}
            </p>
          )}
          <label className="block text-sm text-gray-800 dark:text-gray-200">
            {a.githubTitleLabel}
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" data-testid="report-github-title" />
          </label>
          <label className="block text-sm text-gray-800 dark:text-gray-200">
            {a.githubBodyLabel}
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={12} maxLength={20000} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-2 py-1.5 font-mono text-xs text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" data-testid="report-github-body" />
          </label>
          {err && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{err}</p>}
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={() => void create()} disabled={busy || !title.trim()} data-testid="report-github-submit">{a.githubSubmit}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>{a.githubCancel}</Button>
          </div>
        </div>
      )}
    </Card>
  );
}
