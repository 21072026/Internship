'use client';

import { useCallback, useEffect, useState } from 'react';
import { GraduationCap, Languages, MailWarning, Zap } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useT, useLocale } from '@/i18n/client';
import { formatDateTime } from '@/lib/relativeTime';

/**
 * The reader's newsletter archive (#1469).
 *
 * Rendered from the same fields the e-mail is built from (subject, intro, tips,
 * action, mentor note) rather than from stored HTML: the mail body is
 * table-based Outlook HTML and dropping it into the app would fight both the
 * layout and dark mode. Same content, native rendering.
 */

interface Tip {
  emoji: string;
  title: string;
  body: string;
}

interface Issue {
  id: string;
  audience: string;
  sentAt: string | null;
  // Already resolved into this reader's language by the API.
  subject: string;
  intro: string;
  tips: Tip[];
  action: string | null;
  cta: { label: string; url: string } | null;
  // Null unless this reader is a mentor on a mentor/shared issue.
  mentorNote: string | null;
  languageFallback?: boolean;
  imageUrl: string | null;
}

const PAGE_SIZE = 10;

export default function NewslettersPage() {
  const t = useT();
  const locale = useLocale();
  const n = t.newsletter;
  const [items, setItems] = useState<Issue[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [subscribed, setSubscribed] = useState(true);
  const [resubscribed, setResubscribed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/newsletters?page=${page}&pageSize=${PAGE_SIZE}`);
      if (!res.ok) throw new Error('failed');
      const data = await res.json();
      setItems(data.newsletters ?? []);
      setTotal(data.total ?? 0);
      setSubscribed(data.subscribed !== false);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    load();
  }, [load]);

  // Turning it back on from the archive. Uses the session-authenticated
  // subscription route rather than the token one: the reader is signed in here,
  // so no token needs to exist. The response reports the EFFECTIVE state — with
  // the master e-mail switch off it stays off, and the banner must not claim
  // otherwise.
  const resubscribe = async () => {
    const res = await fetch('/api/newsletter/subscription', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscribed: true }),
    });
    if (!res.ok) return;
    const data = await res.json().catch(() => ({ subscribed: false }));
    setSubscribed(!!data.subscribed);
    setResubscribed(!!data.subscribed);
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{n.archiveTitle}</h1>
        <p className="text-gray-500 mt-1">{n.archiveSubtitle}</p>
      </div>

      {!subscribed && !resubscribed && (
        <Card className="mb-5 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <MailWarning className="h-5 w-5 shrink-0 text-amber-600" />
            <p className="flex-1 text-sm text-gray-700 dark:text-gray-200">{n.archiveUnsubscribed}</p>
            <Button variant="secondary" onClick={resubscribe} data-testid="newsletter-resubscribe">
              {n.archiveResubscribe}
            </Button>
          </div>
        </Card>
      )}
      {resubscribed && (
        <p className="mb-5 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-800 dark:bg-green-950/40 dark:text-green-200">
          {n.archiveResubscribed}
        </p>
      )}

      {loading ? (
        <SkeletonRows rows={3} />
      ) : items.length === 0 ? (
        <Card className="p-8 text-center text-gray-500">{n.archiveEmpty}</Card>
      ) : (
        <div className="space-y-5" data-testid="newsletter-archive">
          {items.map((issue) => (
            <Card key={issue.id} className="overflow-hidden">
              {issue.imageUrl && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={issue.imageUrl} alt="" className="h-40 w-full object-cover" />
              )}
              <div className="p-5">
                <p className="text-xs text-gray-400">
                  {issue.sentAt ? formatDateTime(issue.sentAt, locale) : ''}
                </p>
                <h2 className="mt-1 text-lg font-semibold text-gray-900 dark:text-gray-100">{issue.subject}</h2>
                {issue.languageFallback && (
                  <p className="mt-2 inline-flex items-center gap-1.5 rounded bg-gray-100 px-2 py-1 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                    <Languages className="h-3.5 w-3.5" />
                    {n.archiveFallback}
                  </p>
                )}
                <p className="mt-3 text-sm leading-relaxed text-gray-700 dark:text-gray-200">{issue.intro}</p>

                <ul className="mt-4 space-y-3">
                  {issue.tips.map((tip, i) => (
                    <li key={i} className="flex gap-3">
                      <span className="text-xl leading-6" aria-hidden>{tip.emoji}</span>
                      <div>
                        <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{tip.title}</p>
                        {tip.body && <p className="text-sm text-gray-600 dark:text-gray-300">{tip.body}</p>}
                      </div>
                    </li>
                  ))}
                </ul>

                {issue.action && (
                  <div className="mt-4 rounded-lg bg-blue-50 p-3 text-blue-800 dark:bg-blue-950/40">
                    <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide">
                      <Zap className="h-3.5 w-3.5" />
                      {n.archiveAction}
                    </p>
                    <p className="mt-1 text-sm">{issue.action}</p>
                  </div>
                )}

                {issue.mentorNote && (
                  <div className="mt-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                    <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
                      <GraduationCap className="h-3.5 w-3.5" />
                      {n.archiveMentorNote}
                    </p>
                    <p className="mt-1 text-sm text-gray-700 dark:text-gray-200">{issue.mentorNote}</p>
                  </div>
                )}

                {issue.cta && (
                  <a
                    href={issue.cta.url}
                    className="mt-4 inline-block text-sm font-medium text-blue-700 hover:underline dark:text-blue-300"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {issue.cta.label} →
                  </a>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="mt-6 flex items-center justify-center gap-3">
          <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>←</Button>
          <span className="text-sm text-gray-500">{page} / {totalPages}</span>
          <Button variant="secondary" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>→</Button>
        </div>
      )}
    </div>
  );
}
