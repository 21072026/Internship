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
import { resolveTemplateText } from '@/lib/agendasRule';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { useFilterAnnouncement, resultCountMessage } from '@/hooks/useFilterAnnouncement';

// Management for the guided-conversation library (#1843): the session guides
// a pair picks from (AgendaPanel, #1841). A guide is a title, a "when to use
// it" line and an ordered list of prompts, each written in up to three
// languages, each prompt with an optional note for the person leading the
// session. Sessions instantiated from a guide read every prompt live, so a
// rewording here reaches them; retiring a guide archives it and leaves them
// exactly as they are.

type Translations = Partial<Record<Locale, string>>;

interface PromptDraft {
  id?: string;
  translations: Translations;
  guidance: string;
}

interface Template {
  id: string;
  title: string;
  translations: Translations;
  summary: Translations;
  useCount: number;
  items: { id: string; order: number; prompt: string; translations: Translations; guidance: string | null }[];
}

interface Draft {
  translations: Translations;
  summary: Translations;
  items: PromptDraft[];
}

const emptyPrompt = (): PromptDraft => ({ translations: {}, guidance: '' });
const emptyDraft = (): Draft => ({ translations: {}, summary: {}, items: [emptyPrompt()] });

function draftOf(tpl: Template): Draft {
  return {
    // A guide written before it had translations only has `title`; seed the
    // editor with it under the default locale so it is not lost on save.
    translations: Object.keys(tpl.translations).length > 0 ? tpl.translations : { en: tpl.title },
    summary: tpl.summary,
    items: tpl.items.map((i) => ({
      id: i.id,
      translations: Object.keys(i.translations).length > 0 ? i.translations : { en: i.prompt },
      guidance: i.guidance ?? '',
    })),
  };
}

const filled = (t: Translations) => locales.some((l) => t[l]?.trim());

export default function AdminAgendaTemplatesPage() {
  const t = useT();
  const locale = useLocale();
  const L = t.agendaTemplateAdmin;
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState<Draft>(emptyDraft);
  const [search, setSearch] = useState('');
  const [pendingDelete, setPendingDelete] = useState<{ id: string; title: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/agenda-templates');
    if (res.ok) setTemplates((await res.json()).templates ?? []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const messageFor = (body: { code?: string; error?: string }) => {
    if (body.code === 'title_required') return L.needTitle;
    if (body.code === 'items_required') return L.needPrompt;
    if (body.code === 'duplicate') return L.duplicate;
    return body.error ?? t.common.error;
  };

  const call = async (method: string, body: unknown, key: string) => {
    setBusy(key);
    setError('');
    try {
      const res = await fetch('/api/admin/agenda-templates', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(messageFor(await res.json().catch(() => ({}))));
        return false;
      }
      await load();
      return true;
    } finally {
      setBusy('');
    }
  };

  const payload = (d: Draft) => ({
    translations: d.translations,
    summary: d.summary,
    items: d.items
      .filter((i) => filled(i.translations))
      .map((i) => ({ ...(i.id ? { id: i.id } : {}), translations: i.translations, guidance: i.guidance.trim() || undefined })),
  });

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!filled(draft.translations)) { setError(L.needTitle); return; }
    if (!draft.items.some((i) => filled(i.translations))) { setError(L.needPrompt); return; }
    if (await call('POST', payload(draft), 'create')) setDraft(emptyDraft());
  };

  const save = async (id: string) => {
    if (!filled(edit.translations)) { setError(L.needTitle); return; }
    if (!edit.items.some((i) => filled(i.translations))) { setError(L.needPrompt); return; }
    if (await call('PATCH', { id, ...payload(edit) }, id)) setEditingId(null);
  };

  const remove = (tpl: Template) =>
    setPendingDelete({ id: tpl.id, title: resolveTemplateText({ text: tpl.title, translations: tpl.translations }, locale) });

  const confirmRemove = async () => {
    if (!pendingDelete || busy === pendingDelete.id) return;
    await call('DELETE', { id: pendingDelete.id }, pendingDelete.id);
    setPendingDelete(null);
  };

  const startEdit = (tpl: Template) => {
    setEditingId(tpl.id);
    setEdit(draftOf(tpl));
    setError('');
  };

  // One row of three locale inputs, used for the title, the summary and every prompt.
  const localeInputs = (
    value: Translations,
    onChange: (next: Translations) => void,
    label: string,
    idPrefix: string,
    maxLength: number
  ) => (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {locales.map((l) => (
        <Input
          key={l}
          label={label.replace('{lang}', l.toUpperCase())}
          lang={l}
          value={value[l] ?? ''}
          maxLength={maxLength}
          onChange={(e) => onChange({ ...value, [l]: e.target.value })}
          data-testid={`${idPrefix}-${l}`}
        />
      ))}
    </div>
  );

  const editor = (value: Draft, onChange: (next: Draft) => void, idPrefix: string) => (
    <div className="space-y-4">
      {localeInputs(value.translations, (translations) => onChange({ ...value, translations }), L.titleLabel, `${idPrefix}`, TEXT_LIMITS.todoTitle)}
      {localeInputs(value.summary, (summary) => onChange({ ...value, summary }), L.summaryLabel, `${idPrefix}-summary`, TEXT_LIMITS.agendaSummary)}
      <div className="space-y-3">
        <p className="text-sm font-medium text-gray-700 dark:text-gray-200">{L.prompts}</p>
        {value.items.map((item, index) => (
          <div key={item.id ?? `new-${index}`} className="space-y-2 rounded-lg border border-gray-200 p-3 dark:border-gray-700" data-testid={`${idPrefix}-prompt-${index}`}>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                {localeInputs(
                  item.translations,
                  (translations) => onChange({ ...value, items: value.items.map((it, i) => (i === index ? { ...it, translations } : it)) }),
                  L.promptLabel.replace('{n}', String(index + 1)),
                  `${idPrefix}-item-${index}`,
                  TEXT_LIMITS.todoTitle
                )}
              </div>
              {value.items.length > 1 && (
                <button
                  type="button"
                  onClick={() => onChange({ ...value, items: value.items.filter((_, i) => i !== index) })}
                  aria-label={L.removePrompt.replace('{n}', String(index + 1))}
                  className="mt-7 text-gray-400 hover:text-red-600"
                  data-testid={`${idPrefix}-remove-item-${index}`}
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <Input
              label={L.guidanceLabel}
              value={item.guidance}
              maxLength={TEXT_LIMITS.agendaGuidance}
              onChange={(e) => onChange({ ...value, items: value.items.map((it, i) => (i === index ? { ...it, guidance: e.target.value } : it)) })}
              data-testid={`${idPrefix}-item-${index}-guidance`}
            />
          </div>
        ))}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onChange({ ...value, items: [...value.items, emptyPrompt()] })}
          data-testid={`${idPrefix}-add-item`}
        >
          <Plus className="mr-1 h-3.5 w-3.5" /> {L.addPrompt}
        </Button>
      </div>
    </div>
  );

  const q = search.trim().toLowerCase();
  const filtered = templates.filter(
    (tpl) =>
      !q ||
      [tpl.title, ...Object.values(tpl.translations), ...tpl.items.flatMap((i) => [i.prompt, ...Object.values(i.translations)])].some(
        (v) => v?.toLowerCase().includes(q)
      )
  );

  // WCAG 4.1.3 (#2864): the list is rewritten in place without moving focus,
  // so the new result count is spoken (debounced) while a filter is active.
  useFilterAnnouncement(!loading && q !== '' ? resultCountMessage(t.a11y, filtered.length) : null);

  return (
    <>
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{L.title}</h1>
        <p className="text-gray-500 mt-1">{L.subtitle}</p>
      </div>

      <Card className="mb-6 max-w-4xl">
        <CardHeader>
          <CardTitle>{L.newTemplate}</CardTitle>
          <CardDescription>{L.newTemplateHint}</CardDescription>
        </CardHeader>
        <form onSubmit={create} className="space-y-4">
          {editor(draft, setDraft, 'new-agenda-template')}
          <div className="flex justify-end">
            <Button type="submit" loading={busy === 'create'} data-testid="create-agenda-template">
              <Plus className="mr-1 h-4 w-4" /> {L.add}
            </Button>
          </div>
        </form>
        {error && !editingId && <p className="mt-2 text-sm text-red-600" role="alert">{error}</p>}
      </Card>

      <Card className="max-w-4xl">
        <CardHeader>
          <CardTitle>{L.library.replace('{n}', String(templates.length))}</CardTitle>
        </CardHeader>
        <div className="mb-3">
          {/* AdminNav renders its own search input on every admin page, so the
              spec targets this one by its test id. */}
          <Input
            type="search"
            placeholder={L.searchPlaceholder}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="agenda-template-search"
          />
        </div>

        {loading ? (
          <SkeletonRows rows={5} />
        ) : filtered.length === 0 ? (
          <EmptyState testId="agenda-templates" title={L.none} />
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {filtered.map((tpl) => (
              <li key={tpl.id} className="py-4" data-testid={`agenda-template-${tpl.id}`}>
                {editingId === tpl.id ? (
                  <div className="space-y-3">
                    {editor(edit, setEdit, `edit-agenda-template-${tpl.id}`)}
                    {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
                    <div className="flex justify-end gap-2">
                      <Button type="button" size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                        <X className="mr-1 h-3.5 w-3.5" /> {t.common.cancel}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        loading={busy === tpl.id}
                        onClick={() => save(tpl.id)}
                        data-testid={`save-agenda-template-${tpl.id}`}
                      >
                        <Check className="mr-1 h-3.5 w-3.5" /> {t.common.save}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-sm font-medium text-gray-900 dark:text-gray-100">
                        {resolveTemplateText({ text: tpl.title, translations: tpl.translations }, locale)}
                      </p>
                      {resolveTemplateText({ text: '', translations: tpl.summary }, locale) && (
                        <p className="mt-0.5 break-words text-xs text-gray-500">
                          {resolveTemplateText({ text: '', translations: tpl.summary }, locale)}
                        </p>
                      )}
                      <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-sm text-gray-700 dark:text-gray-300">
                        {tpl.items.map((item) => (
                          <li key={item.id} className="break-words">
                            {resolveTemplateText({ text: item.prompt, translations: item.translations }, locale)}
                            {item.guidance && <span className="ml-1 text-xs text-gray-400">— {item.guidance}</span>}
                          </li>
                        ))}
                      </ol>
                      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-gray-400">
                        <span>{L.promptsCount.replace('{n}', String(tpl.items.length))}</span>
                        {locales.some((l) => !tpl.translations[l]) && (
                          <span className="text-amber-600 dark:text-amber-500">
                            {L.missingLangs.replace(
                              '{langs}',
                              locales.filter((l) => !tpl.translations[l]).map((l) => l.toUpperCase()).join(', ')
                            )}
                          </span>
                        )}
                        {tpl.useCount > 0 && <span>{L.used.replace('{n}', String(tpl.useCount))}</span>}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => startEdit(tpl)}
                      aria-label={t.common.edit}
                      className="text-gray-400 hover:text-blue-600"
                      data-testid={`edit-agenda-template-${tpl.id}`}
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(tpl)}
                      disabled={busy === tpl.id}
                      aria-label={t.common.delete}
                      className="text-gray-400 hover:text-red-600"
                      data-testid={`delete-agenda-template-${tpl.id}`}
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
      message={pendingDelete ? L.confirmDelete.replace('{title}', pendingDelete.title) : ''}
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
