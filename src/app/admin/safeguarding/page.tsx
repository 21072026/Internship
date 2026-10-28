'use client';

import { useFilterAnnouncement, resultCountMessage } from '@/hooks/useFilterAnnouncement';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ShieldAlert } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { LoadErrorCard } from '@/components/ui/LoadErrorCard';
import { fillTemplate } from '@/components/ui/fillTemplate';
import { useLocale, useT } from '@/i18n/client';

// /admin/safeguarding (#2056) — the review queue for messages that shared a
// contact detail or hit the org's watch list, plus the watch list itself and
// the message-retention window. Reads GET /api/admin/safeguarding; records a
// review through PATCH /api/admin/safeguarding/[id]; settings through
// /api/admin/safeguarding/settings. Every one of those checks ADMIN at the
// route — this page being under /admin is not the authorization.

const DOCS_URL = 'https://github.com/21072026/Internship/blob/main/docs/safeguarding.md';

type Kind = 'CONTACT_DETAIL' | 'KEYWORD';
type Outcome = 'NO_ACTION' | 'REVIEWED' | 'ESCALATED';
type Status = 'open' | 'reviewed' | 'all';

interface Row {
  id: string;
  kind: Kind;
  matchedTerm: string;
  createdAt: string;
  reviewedAt: string | null;
  outcome: Outcome | null;
  reviewedBy: { id: string; name: string | null } | null;
  messageRemoved: boolean;
  context: string | null;
  sentAt: string;
  sender: { id: string; name: string | null; role: string | null };
  relation: { id: string; mentor: { id: string; name: string | null }; mentee: { id: string; name: string | null } } | null;
  threadLink: string | null;
}

interface QueueBody {
  counts: { open: number; reviewed: number };
  total: number;
  page: number;
  pageSize: number;
  rows: Row[];
}

interface SettingsBody {
  keywords: string[];
  messageRetentionDays: number;
  limits: { maxKeywords: number; maxLength: number; retentionFloorDays: number };
}

const OUTCOME_VARIANT: Record<Outcome, 'success' | 'info' | 'danger'> = {
  NO_ACTION: 'success',
  REVIEWED: 'info',
  ESCALATED: 'danger',
};

function SettingsCard() {
  const s = useT().safeguarding;
  const [data, setData] = useState<SettingsBody | null>(null);
  const [keywords, setKeywords] = useState('');
  const [days, setDays] = useState('0');
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');

  useEffect(() => {
    fetch('/api/admin/safeguarding/settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((body: SettingsBody | null) => {
        if (!body) return;
        setData(body);
        setKeywords(body.keywords.join('\n'));
        setDays(String(body.messageRetentionDays));
      })
      .catch(() => {});
  }, []);

  const save = async () => {
    setState('saving');
    const n = Number.parseInt(days, 10);
    const res = await fetch('/api/admin/safeguarding/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keywords: keywords.split('\n').map((k) => k.trim()).filter(Boolean),
        messageRetentionDays: Number.isFinite(n) && n > 0 ? n : 0,
      }),
    }).catch(() => null);
    if (!res?.ok) return setState('failed');
    const body = (await res.json()) as SettingsBody;
    setData(body);
    setKeywords(body.keywords.join('\n'));
    setDays(String(body.messageRetentionDays));
    setState('saved');
  };

  const floor = String(data?.limits.retentionFloorDays ?? 30);
  return (
    <Card className="p-5 space-y-4" data-testid="safeguarding-settings">
      <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{s.settingsTitle}</h2>
      <div>
        <label htmlFor="safeguarding-keywords" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {s.keywordsLabel}
        </label>
        <Textarea
          id="safeguarding-keywords"
          rows={5}
          value={keywords}
          onChange={(e) => setKeywords(e.target.value)}
          data-testid="safeguarding-keywords"
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {s.keywordsHint.replace('{max}', String(data?.limits.maxKeywords ?? 100))}
        </p>
      </div>
      <Input
        label={s.retentionLabel}
        type="number"
        min={0}
        max={9999}
        value={days}
        onChange={(e) => setDays(e.target.value)}
        hint={s.retentionHint.split('{floor}').join(floor)}
        data-testid="safeguarding-retention-days"
      />
      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={state === 'saving'} data-testid="safeguarding-settings-save">
          {s.save}
        </Button>
        {state === 'saved' && <span className="text-sm text-green-700 dark:text-green-400" data-testid="safeguarding-settings-saved">{s.saved}</span>}
        {state === 'failed' && <span className="text-sm text-red-700 dark:text-red-400">{s.saveFailed}</span>}
      </div>
    </Card>
  );
}

export default function SafeguardingPage() {
  const t = useT();
  const s = t.safeguarding;
  const locale = useLocale();
  const [status, setStatus] = useState<Status>('open');
  const [kind, setKind] = useState<'' | Kind>('');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<QueueBody | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  // Debounce the search box so typing does not fire a request per key.
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(q.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    setError(false);
    const params = new URLSearchParams({ status, page: String(page) });
    if (kind) params.set('kind', kind);
    if (query) params.set('q', query);
    const res = await fetch(`/api/admin/safeguarding?${params.toString()}`).catch(() => null);
    if (!res?.ok) {
      setError(true);
      return;
    }
    setData((await res.json()) as QueueBody);
  }, [status, kind, query, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const review = async (id: string, body: { outcome: Outcome } | { reopen: true }) => {
    setBusy(id);
    const res = await fetch(`/api/admin/safeguarding/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => null);
    setBusy(null);
    if (res?.ok) void load();
  };

  const tabs: { key: Status; label: string }[] = [
    { key: 'open', label: s.tabOpen },
    { key: 'reviewed', label: s.tabReviewed },
    { key: 'all', label: s.tabAll },
  ];
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  // WCAG 4.1.3 (#2864): the list is rewritten in place without moving focus,
  // so the new result count is spoken (debounced) while a filter is active.
  useFilterAnnouncement(data && (query !== '' || kind !== '') ? resultCountMessage(t.a11y, data.total) : null);

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
          <ShieldAlert className="w-6 h-6" aria-hidden="true" />
          {s.title}
        </h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{s.subtitle}</p>
        <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-sm text-blue-700 dark:text-blue-400 underline">
          {s.docs}
        </a>
      </div>

      <Card className="p-5 space-y-4">
        <div className="flex flex-wrap items-center gap-2" role="tablist">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={status === tab.key}
              onClick={() => {
                setStatus(tab.key);
                setPage(1);
              }}
              className={`px-3 py-1.5 rounded-md text-sm font-medium ${
                status === tab.key
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200'
              }`}
              data-testid={`safeguarding-tab-${tab.key}`}
            >
              {tab.label}
            </button>
          ))}
          {data && (
            <span className="ml-auto text-sm text-gray-600 dark:text-gray-400" data-testid="safeguarding-counts">
              {s.counts.replace('{open}', data.counts.open.toLocaleString(locale)).replace('{reviewed}', data.counts.reviewed.toLocaleString(locale))}
            </span>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            type="search"
            aria-label={s.searchPlaceholder}
            placeholder={s.searchPlaceholder}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            data-testid="safeguarding-search"
          />
          <Select
            aria-label={s.kindAll}
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as '' | Kind);
              setPage(1);
            }}
            options={[
              { value: '', label: s.kindAll },
              { value: 'CONTACT_DETAIL', label: s.kindContact },
              { value: 'KEYWORD', label: s.kindKeyword },
            ]}
            data-testid="safeguarding-kind"
          />
        </div>

        {error ? (
          <LoadErrorCard onRetry={() => void load()} testId="safeguarding-load-error" />
        ) : !data ? (
          <SkeletonRows rows={4} />
        ) : data.rows.length === 0 ? (
          <p className="text-sm text-gray-600 dark:text-gray-400" data-testid="safeguarding-empty">{s.empty}</p>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-800" data-testid="safeguarding-list">
            {data.rows.map((row) => (
              <li key={row.id} className="py-4 space-y-2" data-testid={`safeguarding-flag-${row.id}`}>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge variant={row.kind === 'CONTACT_DETAIL' ? 'warning' : 'purple'}>
                    {row.kind === 'CONTACT_DETAIL' ? s.kindContact : s.kindKeyword}
                  </Badge>
                  <span className="text-gray-700 dark:text-gray-300">
                    {s.matched}: <code className="font-mono" data-testid="safeguarding-term">{row.matchedTerm}</code>
                  </span>
                  <span className="text-gray-500 dark:text-gray-400">
                    <RelativeTime date={row.sentAt} />
                  </span>
                  {row.outcome && (
                    <Badge variant={OUTCOME_VARIANT[row.outcome]} data-testid="safeguarding-outcome">
                      {row.reviewedBy?.name
                        ? s.reviewedBy.replace('{outcome}', s.outcome[row.outcome]).replace('{name}', row.reviewedBy.name)
                        : s.outcome[row.outcome]}
                    </Badge>
                  )}
                </div>
                <div className="text-sm text-gray-700 dark:text-gray-300">
                  {fillTemplate(s.from, { name: <strong>{row.sender.name ?? '—'}</strong> })}
                  {row.sender.role ? <span className="text-gray-500 dark:text-gray-400"> · {row.sender.role}</span> : null}
                  {row.relation ? (
                    <span className="text-gray-500 dark:text-gray-400">
                      {' · '}
                      {s.pair.replace('{a}', row.relation.mentor.name ?? '—').replace('{b}', row.relation.mentee.name ?? '—')}
                    </span>
                  ) : null}
                </div>
                {row.messageRemoved ? (
                  <p className="text-sm italic text-gray-500 dark:text-gray-400">{s.messageRemoved}</p>
                ) : (
                  <blockquote
                    className="border-l-4 border-amber-300 dark:border-amber-600 pl-3 text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap break-words"
                    data-testid="safeguarding-context"
                  >
                    {row.context}
                  </blockquote>
                )}
                <div className="flex flex-wrap gap-2">
                  {row.reviewedAt ? (
                    <Button size="sm" variant="outline" disabled={busy === row.id} onClick={() => review(row.id, { reopen: true })} data-testid="safeguarding-reopen">
                      {s.reopen}
                    </Button>
                  ) : (
                    <>
                      <Button size="sm" variant="outline" disabled={busy === row.id} onClick={() => review(row.id, { outcome: 'NO_ACTION' })} data-testid="safeguarding-no-action">
                        {s.actionNoAction}
                      </Button>
                      <Button size="sm" variant="outline" disabled={busy === row.id} onClick={() => review(row.id, { outcome: 'REVIEWED' })} data-testid="safeguarding-reviewed">
                        {s.actionReviewed}
                      </Button>
                      <Button size="sm" variant="danger" disabled={busy === row.id} onClick={() => review(row.id, { outcome: 'ESCALATED' })} data-testid="safeguarding-escalate">
                        {s.actionEscalate}
                      </Button>
                    </>
                  )}
                  {row.threadLink && !row.messageRemoved && (
                    <Link href={row.threadLink} className="inline-flex items-center text-sm text-blue-700 dark:text-blue-400 underline px-2">
                      {s.openThread}
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {data && pages > 1 && (
          <div className="flex items-center justify-between">
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              {s.previous}
            </Button>
            <span className="text-sm text-gray-600 dark:text-gray-400">
              {page.toLocaleString(locale)} / {pages.toLocaleString(locale)}
            </span>
            <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
              {s.next}
            </Button>
          </div>
        )}
      </Card>

      <SettingsCard />
    </div>
  );
}
