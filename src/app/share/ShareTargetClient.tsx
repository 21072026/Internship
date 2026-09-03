'use client';

import { useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, ExternalLink, MessageSquare } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useT } from '@/i18n/client';

interface Props {
  sharedTitle: string;
  sharedText: string;
  link: string | null;
  suggested: string;
}

/**
 * Read-and-confirm half of the share target (#2084). It receives what another
 * app shared and offers one thing to do with it — put it on your own to-do
 * list — behind an explicit press. The POST happens on submit and nowhere else,
 * so opening /share with any parameters at all changes nothing on its own.
 */
export function ShareTargetClient({ sharedTitle, sharedText, link, suggested }: Props) {
  const t = useT();
  const [title, setTitle] = useState(suggested);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);

  const nothingShared = !sharedTitle && !sharedText && !link;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = title.trim();
    if (!value || saving) return;
    setSaving(true);
    setFailed(false);
    try {
      const res = await fetch('/api/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: value.slice(0, 300) }),
      });
      if (!res.ok) throw new Error('save failed');
      setSaved(true);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  if (nothingShared) {
    return (
      <Card>
        <p className="text-sm text-gray-600 dark:text-gray-300">{t.share.empty}</p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <dl className="space-y-3 text-sm">
          {sharedTitle && (
            <div>
              <dt className="font-medium text-gray-500">{t.share.titleLabel}</dt>
              <dd className="mt-0.5 break-words text-gray-900 dark:text-gray-100">{sharedTitle}</dd>
            </div>
          )}
          {sharedText && (
            <div>
              <dt className="font-medium text-gray-500">{t.share.textLabel}</dt>
              <dd className="mt-0.5 whitespace-pre-wrap break-words text-gray-900 dark:text-gray-100">
                {sharedText}
              </dd>
            </div>
          )}
          {link && (
            <div>
              <dt className="font-medium text-gray-500">{t.share.linkLabel}</dt>
              <dd className="mt-0.5 break-all">
                <a
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-blue-600 hover:underline dark:text-blue-400"
                >
                  {link}
                  <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                </a>
              </dd>
            </div>
          )}
        </dl>
      </Card>

      <Card>
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{t.share.saveAsTodo}</h2>
        <p className="mt-1 text-sm text-gray-500">{t.share.todoHint}</p>
        {saved ? (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
              <CheckCircle2 className="h-4 w-4" />
              {t.share.saved}
            </span>
            <Link href="/todos" className="text-sm text-blue-600 hover:underline dark:text-blue-400">
              {t.share.viewTodos}
            </Link>
          </div>
        ) : (
          <form onSubmit={save} className="mt-4 space-y-3">
            <Input
              id="share-todo-title"
              label={t.share.todoLabel}
              value={title}
              maxLength={300}
              onChange={(e) => setTitle(e.target.value)}
              error={failed ? t.share.failed : undefined}
            />
            <Button type="submit" loading={saving} disabled={!title.trim()}>
              {saving ? t.share.saving : t.share.save}
            </Button>
          </form>
        )}
      </Card>

      <p className="text-sm text-gray-500">
        {t.share.messagesHint}{' '}
        <Link
          href="/messages"
          className="inline-flex items-center gap-1.5 text-blue-600 hover:underline dark:text-blue-400"
        >
          <MessageSquare className="h-3.5 w-3.5" />
          {t.share.messages}
        </Link>
      </p>
    </div>
  );
}
