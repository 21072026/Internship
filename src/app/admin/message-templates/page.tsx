'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useT, useLocale } from '@/i18n/client';
import { locales, type Locale } from '@/i18n/config';
import {
  MAX_TEMPLATE_BODY,
  resolveMessageTemplateText,
  type MessageTemplateDto,
} from '@/lib/messageTemplates';

// Management for the org-wide canned-response pool (#1871). The mirror of
// /admin/goal-templates, one level up in length: a canned reply is a paragraph,
// so the three language fields are textareas rather than single-line inputs.
//
// A mentor picks these from the composer and gets the text in *their* language
// (src/lib/messageTemplates.ts) — which is why this screen wants all three
// filled in, and says which are missing when they are not.

type Translations = Partial<Record<Locale, string>>;

const emptyDraft: Translations = {};

export default function AdminMessageTemplatesPage() {
  const t = useT();
  const locale = useLocale();
  const [templates, setTemplates] = useState<MessageTemplateDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<Translations>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState<Translations>(emptyDraft);
  const [search, setSearch] = useState('');
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/message-templates');
    if (res.ok) setTemplates((await res.json()).templates ?? []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const call = async (method: string, body: unknown, key: string) => {
    setBusy(key);
    setError('');
    try {
      const res = await fetch('/api/admin/message-templates', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError((await res.json().catch(() => ({}))).error ?? t.common.error);
        return false;
      }
      await load();
      return true;
    } finally {
      setBusy('');
    }
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!locales.some((l) => draft[l]?.trim())) return;
    if (await call('POST', { translations: draft }, 'create')) setDraft(emptyDraft);
  };

  const save = async (id: string) => {
    if (await call('PATCH', { id, translations: edit }, id)) setEditingId(null);
  };

  const confirmRemove = async () => {
    if (!pendingDelete || busy === pendingDelete) return;
    await call('DELETE', { id: pendingDelete }, pendingDelete);
    setPendingDelete(null);
  };

  const startEdit = (tpl: MessageTemplateDto) => {
    setEditingId(tpl.id);
    // A row stored before it had translations only has `title`; seed the editor
    // with it under the default locale so saving does not drop the wording.
    setEdit(Object.keys(tpl.translations).length > 0 ? tpl.translations : { en: tpl.title });
  };

  const localeFields = (value: Translations, onChange: (next: Translations) => void, idPrefix: string) => (
    <div className="space-y-3">
      {locales.map((l) => (
        <label key={l} className="block">
          <span className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
            {t.messageTemplateAdmin.langLabel.replace('{lang}', l.toUpperCase())}
          </span>
          <Textarea
            rows={3}
            maxLength={MAX_TEMPLATE_BODY}
            showCounter
            value={value[l] ?? ''}
            onChange={(e) => onChange({ ...value, [l]: e.target.value })}
            data-testid={`${idPrefix}-${l}`}
          />
        </label>
      ))}
    </div>
  );

  const q = search.trim().toLowerCase();
  const filtered = templates.filter(
    (tpl) => !q || [tpl.title, ...Object.values(tpl.translations)].some((v) => v?.toLowerCase().includes(q))
  );

  return (
    <>
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.messageTemplateAdmin.title}</h1>
        <p className="text-gray-500 mt-1">{t.messageTemplateAdmin.subtitle}</p>
      </div>

      <Card className="mb-6 max-w-3xl">
        <CardHeader>
          <CardTitle>{t.messageTemplateAdmin.newTemplate}</CardTitle>
          <CardDescription>{t.messageTemplateAdmin.newTemplateHint}</CardDescription>
        </CardHeader>
        <form onSubmit={create} className="space-y-3">
          {localeFields(draft, setDraft, 'new-message-template')}
          <div className="flex justify-end">
            <Button type="submit" loading={busy === 'create'} data-testid="create-message-template">
              <Plus className="mr-1 h-4 w-4" /> {t.messageTemplateAdmin.add}
            </Button>
          </div>
        </form>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </Card>

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>{t.messageTemplateAdmin.pool.replace('{n}', String(templates.length))}</CardTitle>
        </CardHeader>
        <div className="mb-3">
          <Input
            type="search"
            placeholder={t.messageTemplateAdmin.searchPlaceholder}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="message-template-search"
          />
        </div>

        {loading ? (
          <SkeletonRows rows={5} />
        ) : filtered.length === 0 ? (
          <EmptyState testId="message-templates" title={t.messageTemplateAdmin.none} />
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {filtered.map((tpl) => (
              <li key={tpl.id} className="py-3" data-testid={`message-template-${tpl.id}`}>
                {editingId === tpl.id ? (
                  <div className="space-y-3">
                    {localeFields(edit, setEdit, `edit-message-template-${tpl.id}`)}
                    <div className="flex justify-end gap-2">
                      <Button type="button" size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                        <X className="mr-1 h-3.5 w-3.5" /> {t.common.cancel}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        loading={busy === tpl.id}
                        onClick={() => save(tpl.id)}
                        data-testid={`save-message-template-${tpl.id}`}
                      >
                        <Check className="mr-1 h-3.5 w-3.5" /> {t.common.save}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="whitespace-pre-wrap break-words text-sm text-gray-900 dark:text-gray-100">
                        {resolveMessageTemplateText(tpl, locale)}
                      </p>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-gray-400">
                        {locales.some((l) => !tpl.translations[l]) && (
                          <span className="text-amber-600 dark:text-amber-500">
                            {t.messageTemplateAdmin.missingLangs.replace(
                              '{langs}',
                              locales.filter((l) => !tpl.translations[l]).map((l) => l.toUpperCase()).join(', ')
                            )}
                          </span>
                        )}
                        {tpl.useCount > 0 && (
                          <span>{t.messageTemplateAdmin.used.replace('{n}', String(tpl.useCount))}</span>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => startEdit(tpl)}
                      aria-label={t.common.edit}
                      className="text-gray-400 hover:text-blue-600"
                      data-testid={`edit-message-template-${tpl.id}`}
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setPendingDelete(tpl.id)}
                      disabled={busy === tpl.id}
                      aria-label={t.common.delete}
                      className="text-gray-400 hover:text-red-600"
                      data-testid={`delete-message-template-${tpl.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
    <ConfirmDialog
      open={pendingDelete !== null}
      message={t.messageTemplateAdmin.confirmDelete}
      cancelLabel={t.common.cancel}
      confirmLabel={t.common.delete}
      variant="danger"
      loading={pendingDelete ? busy === pendingDelete : false}
      onConfirm={confirmRemove}
      onCancel={() => setPendingDelete(null)}
    />
    </>
  );
}
