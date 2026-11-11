'use client';

// The org's offer letter template per language (#1857). An org that saves
// nothing keeps the built-in letter; "Reset to built-in" deletes its own.
// Offers already sent are untouched either way — each carries the text it was
// sent with (Offer.letterSnapshot).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useT } from '@/i18n/client';
import { locales, type Locale } from '@/i18n/config';
import { MERGE_TAGS, OFFER_TEMPLATE_MAX, renderOfferLetter, sampleMergeValues, unknownMergeTags } from '@/lib/offerLetter';
import { OfferLetterView } from '@/components/OfferLetterView';

type Row = { locale: Locale; bodyMarkdown: string; custom: boolean; builtIn: string };

export function OfferLetterTemplateEditor() {
  const t = useT();
  const e = t.offers.letter.editor;
  const [rows, setRows] = useState<Row[] | null>(null);
  const [locale, setLocale] = useState<Locale>('en');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/offer-templates');
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { templates: Row[] };
      setRows(data.templates);
    } catch {
      setError(e.loadFailed);
    }
  }, [e.loadFailed]);

  useEffect(() => {
    void load();
  }, [load]);

  const current = rows?.find((r) => r.locale === locale) ?? null;
  useEffect(() => {
    if (current) setDraft(current.bodyMarkdown);
  }, [current]);

  const unknown = useMemo(() => unknownMergeTags(draft), [draft]);
  const preview = useMemo(() => renderOfferLetter(draft, sampleMergeValues(locale)), [draft, locale]);

  const save = async () => {
    setBusy(true);
    setFlash(null);
    setError(null);
    try {
      const res = await fetch('/api/admin/offer-templates', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale, bodyMarkdown: draft }),
      });
      if (!res.ok) throw new Error();
      setFlash(e.saved);
      await load();
    } catch {
      setError(e.failed);
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    setFlash(null);
    setError(null);
    try {
      const res = await fetch(`/api/admin/offer-templates?locale=${locale}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
      setFlash(e.resetDone);
      await load();
    } catch {
      setError(e.failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card data-testid="offer-letter-template-editor">
      <CardHeader>
        <CardTitle>{e.title}</CardTitle>
      </CardHeader>
      <p className="text-sm text-gray-500 mb-4">{e.subtitle}</p>
      {error && <p className="mb-3 text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      {flash && <p className="mb-3 text-sm text-green-700" role="status">{flash}</p>}
      {rows && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <Select
              label={e.localeLabel}
              value={locale}
              onChange={(ev) => setLocale(ev.target.value as Locale)}
              options={locales.map((l) => ({ value: l, label: l.toUpperCase() }))}
              data-testid="offer-letter-template-locale"
            />
            <Badge variant={current?.custom ? 'info' : 'default'} data-testid="offer-letter-template-kind">
              {current?.custom ? e.custom : e.builtIn}
            </Badge>
          </div>
          <label htmlFor="offer-letter-template-body" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            {e.body}
          </label>
          <Textarea
            id="offer-letter-template-body"
            rows={14}
            maxLength={OFFER_TEMPLATE_MAX}
            value={draft}
            onChange={(ev) => setDraft(ev.target.value)}
            data-testid="offer-letter-template-body"
          />
          <p className="text-xs text-gray-500">
            {e.tags}: {MERGE_TAGS.map((tag) => `{{${tag}}}`).join(' ')}
          </p>
          {unknown.length > 0 && (
            <p className="text-xs text-amber-700" data-testid="offer-letter-template-unknown">
              {e.unknownTags.replace('{tags}', unknown.map((u) => `{{${u}}}`).join(', '))}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={save} loading={busy} disabled={!draft.trim()} data-testid="offer-letter-template-save">
              {e.save}
            </Button>
            {current?.custom && (
              <Button variant="outline" onClick={reset} disabled={busy} data-testid="offer-letter-template-reset">
                {e.reset}
              </Button>
            )}
          </div>
          <div className="rounded-lg border border-gray-100 dark:border-gray-700 p-4">
            <p className="text-xs font-medium text-gray-500 mb-2">{e.preview}</p>
            <OfferLetterView markdown={preview} testId="offer-letter-template-preview" />
          </div>
        </div>
      )}
    </Card>
  );
}
