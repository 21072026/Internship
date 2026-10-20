'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { AttributeValueImport } from '@/components/AttributeValueImport';
import { useT, useLocale } from '@/i18n/client';
import { locales, type Locale } from '@/i18n/config';
import { ATTRIBUTE_TYPES, MAX_LABEL_LENGTH, attributeLabel, type AttributeType } from '@/lib/orgAttributesRule';

// The org's segmentation attributes (#1920): the dimensions a report can be
// sliced by — a department, a level, a location, a start date. The admin names
// each one in up to three languages; a list's options are typed one per line.
// Values arrive through the admin import. Deliberately no presets, and above
// all no special-category one (docs/analytics.md § Dimensions).

type Labels = Partial<Record<Locale, string>>;

interface Attribute {
  id: string;
  key: string;
  labelEn: string;
  labelTr: string;
  labelDe: string;
  type: AttributeType;
  options: string[];
  isSegmentable: boolean;
  valueCount: number;
}

interface Draft {
  key: string;
  labels: Labels;
  type: AttributeType;
  options: string;
  isSegmentable: boolean;
}

const emptyDraft = (): Draft => ({ key: '', labels: {}, type: 'SELECT', options: '', isSegmentable: true });
const optionLines = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const labelsOf = (a: Attribute): Labels => ({ en: a.labelEn, tr: a.labelTr, de: a.labelDe });

export default function AdminAttributesPage() {
  const t = useT();
  const locale = useLocale();
  const L = t.orgAttributesAdmin;
  const [attributes, setAttributes] = useState<Attribute[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState<Draft>(emptyDraft);
  const [pendingDelete, setPendingDelete] = useState<{ attr: Attribute; refs: { views: number; subscriptions: number } | null } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/attributes');
    if (res.ok) setAttributes((await res.json()).attributes ?? []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const messageFor = (body: { code?: string; error?: string }) => {
    const known: Record<string, string> = {
      label_required: L.needLabel,
      invalid_key: L.invalidKey,
      options_required: L.needOptions,
      duplicate: L.duplicate,
      too_many: L.tooMany,
    };
    return (body.code && known[body.code]) || body.error || t.common.error;
  };

  const call = async (method: string, body: unknown, key: string) => {
    setBusy(key);
    setError('');
    try {
      const res = await fetch('/api/admin/attributes', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false as const, status: res.status, json };
      await load();
      return { ok: true as const, status: res.status, json };
    } finally {
      setBusy('');
    }
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const result = await call(
      'POST',
      { key: draft.key.trim() || undefined, labels: draft.labels, type: draft.type, options: optionLines(draft.options), isSegmentable: draft.isSegmentable },
      'create'
    );
    if (result.ok) setDraft(emptyDraft());
    else setError(messageFor(result.json));
  };

  const save = async (a: Attribute) => {
    const result = await call(
      'PATCH',
      { id: a.id, labels: edit.labels, isSegmentable: edit.isSegmentable, ...(a.type === 'SELECT' ? { options: optionLines(edit.options) } : {}) },
      a.id
    );
    if (result.ok) setEditingId(null);
    else setError(messageFor(result.json));
  };

  const move = async (index: number, delta: -1 | 1) => {
    const order = attributes.map((a) => a.id);
    const [moved] = order.splice(index, 1);
    order.splice(index + delta, 0, moved);
    const result = await call('PATCH', { order }, `move-${moved}`);
    if (!result.ok) setError(messageFor(result.json));
  };

  const remove = async (confirmed: boolean) => {
    if (!pendingDelete) return;
    const result = await call('DELETE', { id: pendingDelete.attr.id, confirm: confirmed }, pendingDelete.attr.id);
    if (!result.ok && result.status === 409 && result.json.code === 'referenced') {
      setPendingDelete({ attr: pendingDelete.attr, refs: { views: result.json.views ?? 0, subscriptions: result.json.subscriptions ?? 0 } });
      return;
    }
    if (!result.ok) setError(messageFor(result.json));
    setPendingDelete(null);
  };

  const typeOptions = ATTRIBUTE_TYPES.map((value) => ({ value, label: L.types[value] }));

  const labelInputs = (value: Labels, onChange: (next: Labels) => void, idPrefix: string) => (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {locales.map((l) => (
        <Input
          key={l}
          label={L.labelIn.replace('{lang}', l.toUpperCase())}
          value={value[l] ?? ''}
          maxLength={MAX_LABEL_LENGTH}
          onChange={(e) => onChange({ ...value, [l]: e.target.value })}
          data-testid={`${idPrefix}-label-${l}`}
        />
      ))}
    </div>
  );

  const optionsInput = (value: string, onChange: (next: string) => void, idPrefix: string) => (
    <label className="block text-sm">
      <span className="font-medium text-gray-700 dark:text-gray-200">{L.options}</span>
      <textarea
        className="mt-1 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
        rows={4}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={`${idPrefix}-options`}
      />
      <span className="mt-1 block text-xs text-gray-500">{L.optionsHint}</span>
    </label>
  );

  const segmentableToggle = (value: boolean, onChange: (next: boolean) => void, idPrefix: string) => (
    <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} data-testid={`${idPrefix}-segmentable`} />
      {L.segmentable}
    </label>
  );

  return (
    <>
      <div>
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{L.title}</h1>
          <p className="mt-1 text-gray-500">{L.subtitle}</p>
        </div>

        <Card className="mb-6 max-w-4xl">
          <CardHeader>
            <CardTitle>{L.newAttribute}</CardTitle>
            <CardDescription>{L.newAttributeHint}</CardDescription>
          </CardHeader>
          <form onSubmit={create} className="space-y-4">
            {labelInputs(draft.labels, (labels) => setDraft({ ...draft, labels }), 'new-attribute')}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Select
                label={L.type}
                options={typeOptions}
                value={draft.type}
                onChange={(e) => setDraft({ ...draft, type: e.target.value as AttributeType })}
                data-testid="new-attribute-type"
              />
              <Input
                label={L.key}
                hint={L.keyHint}
                value={draft.key}
                maxLength={64}
                onChange={(e) => setDraft({ ...draft, key: e.target.value })}
                data-testid="new-attribute-key"
              />
            </div>
            {draft.type === 'SELECT' && optionsInput(draft.options, (options) => setDraft({ ...draft, options }), 'new-attribute')}
            {draft.type === 'DATE' && <p className="text-xs text-gray-500">{L.dateHint}</p>}
            {segmentableToggle(draft.isSegmentable, (isSegmentable) => setDraft({ ...draft, isSegmentable }), 'new-attribute')}
            <div className="flex justify-end">
              <Button type="submit" loading={busy === 'create'} data-testid="create-attribute">
                <Plus className="mr-1 h-4 w-4" /> {L.add}
              </Button>
            </div>
          </form>
          {error && !editingId && <p className="mt-2 text-sm text-red-600" role="alert" data-testid="attribute-error">{error}</p>}
        </Card>

        {attributes.length > 0 && <AttributeValueImport onApplied={load} />}
        <Card className="max-w-4xl">
          <CardHeader>
            <CardTitle>{L.list.replace('{n}', String(attributes.length))}</CardTitle>
            <CardDescription>{L.privacyNote}</CardDescription>
          </CardHeader>
          {loading ? (
            <SkeletonRows rows={4} />
          ) : attributes.length === 0 ? (
            <EmptyState testId="attributes" title={L.none} />
          ) : (
            <ul className="divide-y divide-gray-100 dark:divide-gray-800">
              {attributes.map((a, index) => (
                <li key={a.id} className="py-4" data-testid={`attribute-${a.key}`}>
                  {editingId === a.id ? (
                    <div className="space-y-3">
                      {labelInputs(edit.labels, (labels) => setEdit({ ...edit, labels }), `edit-attribute-${a.key}`)}
                      {a.type === 'SELECT' && optionsInput(edit.options, (options) => setEdit({ ...edit, options }), `edit-attribute-${a.key}`)}
                      {segmentableToggle(edit.isSegmentable, (isSegmentable) => setEdit({ ...edit, isSegmentable }), `edit-attribute-${a.key}`)}
                      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
                      <div className="flex justify-end gap-2">
                        <Button type="button" size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                          <X className="mr-1 h-3.5 w-3.5" /> {t.common.cancel}
                        </Button>
                        <Button type="button" size="sm" loading={busy === a.id} onClick={() => save(a)} data-testid={`save-attribute-${a.key}`}>
                          <Check className="mr-1 h-3.5 w-3.5" /> {t.common.save}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="break-words text-sm font-medium text-gray-900 dark:text-gray-100">{attributeLabel(a, locale)}</p>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-gray-500">
                          <code>{a.key}</code>
                          <span>{L.types[a.type]}</span>
                          <span data-testid={`attribute-${a.key}-count`}>{L.valueCount.replace('{n}', String(a.valueCount))}</span>
                          {!a.isSegmentable && <span>{L.notSegmentable}</span>}
                        </div>
                        {a.type === 'SELECT' && a.options.length > 0 && (
                          <p className="mt-1 break-words text-xs text-gray-600 dark:text-gray-400">{a.options.join(' · ')}</p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          disabled={index === 0 || !!busy}
                          onClick={() => move(index, -1)}
                          aria-label={L.moveUp}
                          className="p-1 text-gray-400 hover:text-gray-700 disabled:opacity-30 dark:hover:text-gray-200"
                        >
                          <ArrowUp className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          disabled={index === attributes.length - 1 || !!busy}
                          onClick={() => move(index, 1)}
                          aria-label={L.moveDown}
                          className="p-1 text-gray-400 hover:text-gray-700 disabled:opacity-30 dark:hover:text-gray-200"
                        >
                          <ArrowDown className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(a.id);
                            setEdit({ key: a.key, labels: labelsOf(a), type: a.type, options: a.options.join('\n'), isSegmentable: a.isSegmentable });
                            setError('');
                          }}
                          aria-label={L.edit}
                          className="p-1 text-gray-400 hover:text-blue-600"
                          data-testid={`edit-attribute-${a.key}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setPendingDelete({ attr: a, refs: null })}
                          aria-label={L.remove}
                          className="p-1 text-gray-400 hover:text-red-600"
                          data-testid={`delete-attribute-${a.key}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <ConfirmDialog
        open={!!pendingDelete}
        title={L.removeTitle}
        message={
          pendingDelete?.refs
            ? L.removeReferenced
                .replace('{views}', String(pendingDelete.refs.views))
                .replace('{subscriptions}', String(pendingDelete.refs.subscriptions))
            : L.removeConfirm.replace('{name}', pendingDelete ? attributeLabel(pendingDelete.attr, locale) : '').replace('{n}', String(pendingDelete?.attr.valueCount ?? 0))
        }
        confirmLabel={L.remove}
        cancelLabel={t.common.cancel}
        variant="danger"
        loading={!!pendingDelete && busy === pendingDelete.attr.id}
        onConfirm={() => remove(!!pendingDelete?.refs)}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  );
}
