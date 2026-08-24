'use client';

import { useCallback, useEffect, useState } from 'react';
import { Quote, Send, Upload, Undo2 } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useT, useLocale } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';

// Testimonial moderation (#1098). Only consented-on-both-sides evaluations
// ever reach this screen (the API enforces it — moderation never overrides
// consent). Publishing is a two-person decision: the admin drafts, the author
// approves the exact wording, then publish goes live.

interface Row {
  id: string;
  comment: string | null;
  publicExcerpt: string | null;
  excerptApprovedAt: string | null;
  publishedAt: string | null;
  createdAt: string;
  authorName: string;
  authorRole: 'mentor' | 'mentee';
  subjectName: string;
}

type Tab = 'candidates' | 'review' | 'published';

export default function AdminTestimonialsPage() {
  const t = useT();
  const locale = useLocale();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [tab, setTab] = useState<Tab>('candidates');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch('/api/admin/testimonials')
      .then((r) => (r.ok ? r.json() : { testimonials: [] }))
      .then((d) => setRows(d.testimonials ?? []))
      .catch(() => setRows([]));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const act = async (evaluationId: string, action: 'saveExcerpt' | 'publish' | 'unpublish', excerpt?: string) => {
    setBusy(evaluationId);
    setFlash(null);
    try {
      const res = await fetch('/api/admin/testimonials', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ evaluationId, action, excerpt }),
      });
      if (res.ok) {
        setFlash(t.testimonials.admin[action === 'saveExcerpt' ? 'sentForApproval' : action === 'publish' ? 'published' : 'unpublished']);
        load();
      } else {
        const d = await res.json().catch(() => ({}));
        setFlash(d.error ?? t.common.error);
      }
    } finally {
      setBusy(null);
    }
  };

  const buckets: Record<Tab, Row[]> = {
    candidates: (rows ?? []).filter((r) => !r.publicExcerpt),
    review: (rows ?? []).filter((r) => r.publicExcerpt && !r.publishedAt),
    published: (rows ?? []).filter((r) => !!r.publishedAt),
  };
  const TABS: Tab[] = ['candidates', 'review', 'published'];

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.testimonials.admin.title}</h1>
        <p className="text-gray-500 mt-1">{t.testimonials.admin.subtitle}</p>
      </div>

      {flash && <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700">{flash}</div>}

      <div className="mb-4 flex gap-1 rounded-lg bg-gray-100 dark:bg-gray-800 p-1 max-w-xl" role="tablist">
        {TABS.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            data-testid={`testimonials-tab-${k}`}
            className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition ${
              tab === k ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-900 dark:text-gray-100' : 'text-gray-600 dark:text-gray-300'
            }`}
          >
            {t.testimonials.admin.tabs[k]} ({buckets[k].length})
          </button>
        ))}
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Quote className="h-5 w-5 text-blue-600" />
            <CardTitle>{t.testimonials.admin.tabs[tab]}</CardTitle>
          </div>
        </CardHeader>
        <p className="mb-4 text-xs text-gray-500 dark:text-gray-400">{t.testimonials.admin.consentNote}</p>
        {rows === null ? (
          <p className="py-4 text-sm text-gray-400">{t.common.loading}</p>
        ) : buckets[tab].length === 0 ? (
          <p className="py-4 text-sm text-gray-500" data-testid="testimonials-empty">{t.testimonials.admin.empty}</p>
        ) : (
          <ul className="space-y-4">
            {buckets[tab].map((r) => (
              <li key={r.id} className="rounded-xl border border-gray-100 dark:border-gray-800 p-4" data-testid={`testimonial-row-${r.id}`}>
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="font-medium text-gray-900 dark:text-gray-100">
                    {r.authorName}
                    <span className="ml-1 text-xs text-gray-400">({t.testimonials.admin.roles[r.authorRole]})</span>
                    <span className="mx-1 text-gray-400">→</span>
                    {r.subjectName}
                  </span>
                  <span className="text-xs text-gray-400">{formatDate(r.createdAt, locale)}</span>
                </div>
                {/* The original comment — read-only, never edited (audit rule). */}
                <p className="mt-2 rounded-lg bg-gray-50 dark:bg-gray-800/60 p-3 text-sm text-gray-700 dark:text-gray-300">
                  {r.comment}
                </p>
                <div className="mt-3">
                  <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                    {t.testimonials.admin.excerptLabel}
                  </label>
                  <textarea
                    rows={2}
                    defaultValue={r.publicExcerpt ?? ''}
                    onChange={(e) => setDrafts((d) => ({ ...d, [r.id]: e.target.value }))}
                    data-testid={`testimonial-excerpt-${r.id}`}
                    className="block w-full rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-3 py-2 text-sm"
                  />
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    loading={busy === r.id}
                    disabled={!(drafts[r.id] ?? r.publicExcerpt ?? '').trim()}
                    onClick={() => act(r.id, 'saveExcerpt', drafts[r.id] ?? r.publicExcerpt ?? '')}
                    data-testid={`testimonial-send-${r.id}`}
                  >
                    <Send className="h-4 w-4" />
                    {t.testimonials.admin.sendForApproval}
                  </Button>
                  {r.publicExcerpt && !r.publishedAt && (
                    <Button
                      size="sm"
                      loading={busy === r.id}
                      disabled={!r.excerptApprovedAt}
                      title={r.excerptApprovedAt ? undefined : t.testimonials.admin.awaitingAuthor}
                      onClick={() => act(r.id, 'publish')}
                      data-testid={`testimonial-publish-${r.id}`}
                    >
                      <Upload className="h-4 w-4" />
                      {t.testimonials.admin.publish}
                    </Button>
                  )}
                  {r.publishedAt && (
                    <Button size="sm" variant="outline" loading={busy === r.id} onClick={() => act(r.id, 'unpublish')} data-testid={`testimonial-unpublish-${r.id}`}>
                      <Undo2 className="h-4 w-4" />
                      {t.testimonials.admin.unpublish}
                    </Button>
                  )}
                  {r.publicExcerpt && !r.excerptApprovedAt && !r.publishedAt && (
                    <span className="text-xs text-amber-600 dark:text-amber-400">{t.testimonials.admin.awaitingAuthor}</span>
                  )}
                  {r.excerptApprovedAt && !r.publishedAt && (
                    <span className="text-xs text-green-600 dark:text-green-400">{t.testimonials.admin.authorApproved}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
