'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useT, useLocale } from '@/i18n/client';
import { locales, type Locale } from '@/i18n/config';
import { resolveTemplateTitle } from '@/lib/goalTemplates';

// Management for the shared goal-template pool (#51 follow-up). Every project
// sees these on top of its own, and a mentor hands them to a new member in one
// click — so the wording is worth editing rather than living with whatever the
// seeder wrote. Each goal can be written in all three languages; a member reads
// it in theirs.

type Translations = Partial<Record<Locale, string>>;

interface Template {
  id: string;
  title: string;
  translations: Translations;
  useCount: number;
}

const emptyDraft: Translations = {};

export default function AdminGoalTemplatesPage() {
  const t = useT();
  const locale = useLocale();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<Translations>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState<Translations>(emptyDraft);
  const [search, setSearch] = useState('');
  const [pendingDelete, setPendingDelete] = useState<{ id: string; title: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/goal-templates');
    if (res.ok) setTemplates((await res.json()).templates ?? []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const call = async (method: string, body: unknown, key: string) => {
    setBusy(key);
    setError('');
    try {
      const res = await fetch('/api/admin/goal-templates', {
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

  const remove = (tpl: Template) => setPendingDelete({ id: tpl.id, title: resolveTemplateTitle(tpl, locale) });

  const confirmRemove = async () => {
    if (!pendingDelete || busy === pendingDelete.id) return;
    await call('DELETE', { id: pendingDelete.id }, pendingDelete.id);
    setPendingDelete(null);
  };

  const startEdit = (tpl: Template) => {
    setEditingId(tpl.id);
    // A template written before it had translations only has `title`; seed the
    // editor with it under the default locale so it is not lost on save.
    setEdit(Object.keys(tpl.translations).length > 0 ? tpl.translations : { en: tpl.title });
  };

  const localeInputs = (value: Translations, onChange: (next: Translations) => void, idPrefix: string) => (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {locales.map((l) => (
        <Input
          key={l}
          label={t.goalTemplateAdmin.langLabel.replace('{lang}', l.toUpperCase())}
          value={value[l] ?? ''}
          onChange={(e) => onChange({ ...value, [l]: e.target.value })}
          data-testid={`${idPrefix}-${l}`}
        />
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
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.goalTemplateAdmin.title}</h1>
        <p className="text-gray-500 mt-1">{t.goalTemplateAdmin.subtitle}</p>
      </div>

      <Card className="mb-6 max-w-3xl">
        <CardHeader>
          <CardTitle>{t.goalTemplateAdmin.newTemplate}</CardTitle>
          <CardDescription>{t.goalTemplateAdmin.newTemplateHint}</CardDescription>
        </CardHeader>
        <form onSubmit={create} className="space-y-3">
          {localeInputs(draft, setDraft, 'new-template')}
          <div className="flex justify-end">
            <Button type="submit" loading={busy === 'create'} data-testid="create-template">
              <Plus className="mr-1 h-4 w-4" /> {t.goalTemplateAdmin.add}
            </Button>
          </div>
        </form>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </Card>

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>{t.goalTemplateAdmin.pool.replace('{n}', String(templates.length))}</CardTitle>
        </CardHeader>
        <div className="mb-3">
          <Input
            type="search"
            placeholder={t.goalTemplateAdmin.searchPlaceholder}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="goal-template-search"
          />
        </div>

        {loading ? (
          <SkeletonRows rows={5} />
        ) : filtered.length === 0 ? (
          <EmptyState testId="goal-templates" title={t.goalTemplateAdmin.none} />
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {filtered.map((tpl) => (
              <li key={tpl.id} className="py-3" data-testid={`goal-template-${tpl.id}`}>
                {editingId === tpl.id ? (
                  <div className="space-y-3">
                    {localeInputs(edit, setEdit, `edit-template-${tpl.id}`)}
                    <div className="flex justify-end gap-2">
                      <Button type="button" size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                        <X className="mr-1 h-3.5 w-3.5" /> {t.common.cancel}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        loading={busy === tpl.id}
                        onClick={() => save(tpl.id)}
                        data-testid={`save-template-${tpl.id}`}
                      >
                        <Check className="mr-1 h-3.5 w-3.5" /> {t.common.save}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-sm text-gray-900 dark:text-gray-100">
                        {resolveTemplateTitle(tpl, locale)}
                      </p>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-gray-400">
                        {locales
                          .filter((l) => l !== locale && tpl.translations[l])
                          .map((l) => (
                            <span key={l} className="break-words">
                              <span className="uppercase">{l}</span> · {tpl.translations[l]}
                            </span>
                          ))}
                        {locales.some((l) => !tpl.translations[l]) && (
                          <span className="text-amber-600 dark:text-amber-500">
                            {t.goalTemplateAdmin.missingLangs.replace(
                              '{langs}',
                              locales.filter((l) => !tpl.translations[l]).map((l) => l.toUpperCase()).join(', ')
                            )}
                          </span>
                        )}
                        {tpl.useCount > 0 && <span>{t.projects.templateUsed.replace('{n}', String(tpl.useCount))}</span>}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => startEdit(tpl)}
                      aria-label={t.common.edit}
                      className="text-gray-400 hover:text-blue-600"
                      data-testid={`edit-template-${tpl.id}`}
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(tpl)}
                      disabled={busy === tpl.id}
                      aria-label={t.common.delete}
                      className="text-gray-400 hover:text-red-600"
                      data-testid={`delete-template-${tpl.id}`}
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
      message={pendingDelete ? t.goalTemplateAdmin.confirmDelete.replace('{title}', pendingDelete.title) : ''}
      cancelLabel={t.common.cancel}
      confirmLabel={t.common.delete}
      variant="danger"
      loading={pendingDelete ? busy === pendingDelete.id : false}
      onConfirm={confirmRemove}
      onCancel={() => setPendingDelete(null)}
    />
    </>
  );
}
