'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, Trash2 } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useT } from '@/i18n/client';
import { canBeMatchable, FORM_FIELD_TYPES, type FormFieldType } from '@/lib/forms/schema';
import { diffFormVersions, FORM_KEY_RE, FORM_LOCALES, liveVersion, looksLikeProtectedProxy } from '@/lib/forms/definitionRule';
import { FormFieldInput, type RenderedField } from '@/components/forms/FormFieldInput';

// The form builder (#1802). Fields in order, EN/TR/DE side by side, options for
// choice types, the required and matchable toggles, and a live preview that
// renders through FormFieldInput — the component the real forms use — and
// validates with the shared validateResponse(). Every rule is the server's
// (src/lib/forms/definitions.ts): a disabled toggle here is a courtesy, the API
// refuses the same thing. Saving a published version makes version N+1.

type Loc = (typeof FORM_LOCALES)[number];
type Text = Partial<Record<Loc, string>>;
interface Field {
  id?: string | null;
  key: string;
  type: FormFieldType;
  labels: Text;
  helpText: Text;
  options: { value: string; labels: Text }[];
  required: boolean;
  matchable: boolean;
  archivedAt?: string | null;
}
interface FormDef {
  id: string;
  key: string;
  version: number;
  title: Text | null;
  publishedAt: string | null;
  archivedAt: string | null;
  fields: Field[];
}

const CHOICE = (t: string) => t === 'SELECT' || t === 'MULTI_SELECT';
const clean = (x: Text): Text => Object.fromEntries(Object.entries(x).filter(([, v]) => typeof v === 'string' && v.trim())) as Text;

export default function FormBuilderPage() {
  const t = useT();
  const F = t.formsAdmin;
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const [form, setForm] = useState<FormDef | null>(null);
  const [fields, setFields] = useState<Field[]>([]);
  const [published, setPublished] = useState<Field[] | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [previewLocale, setPreviewLocale] = useState<Loc>('en');
  const [showErrors, setShowErrors] = useState(false);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/forms/${id}`);
    if (!res.ok) return;
    const def: FormDef = (await res.json()).form;
    setForm(def);
    setFields(def.fields.filter((f) => !f.archivedAt).map((f) => ({ ...f, helpText: f.helpText ?? {}, options: f.options ?? [] })));
    // The live version to diff a publish against, when it is another one.
    const list = await (await fetch('/api/admin/forms')).json();
    const live = liveVersion((list.forms as FormDef[]).filter((x) => x.key === def.key));
    if (live && live.id !== def.id) setPublished((await (await fetch(`/api/admin/forms/${live.id}`)).json()).form.fields);
    else setPublished(null);
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const errorText = (body: { code?: string; key?: string; fields?: { key: string }[] }) => {
    const tpl = F.errors[body.code as keyof typeof F.errors] ?? F.errors.generic;
    return tpl.replace('{key}', body.key ?? '').replace('{keys}', (body.fields ?? []).map((f) => f.key).join(', '));
  };

  const set = (i: number, patch: Partial<Field>) => setFields((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const move = (i: number, d: number) => setFields((fs) => {
    const j = i + d;
    if (j < 0 || j >= fs.length) return fs;
    const next = [...fs];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });
  const addField = (type: FormFieldType) => setFields((fs) => [...fs, { key: `field_${fs.length + 1}`, type, labels: {}, helpText: {}, options: CHOICE(type) ? [{ value: 'option_1', labels: {} }] : [], required: false, matchable: false }]);

  const payload = () => ({
    fields: fields.map((f) => ({
      ...(f.id ? { id: f.id } : {}),
      key: f.key,
      type: f.type,
      labels: clean(f.labels),
      helpText: Object.keys(clean(f.helpText)).length ? clean(f.helpText) : null,
      options: CHOICE(f.type) ? f.options.map((o) => ({ value: o.value, labels: clean(o.labels) })) : null,
      required: f.required,
      matchable: canBeMatchable(f) ? f.matchable : false,
    })),
  });

  /** Save; returns the id the edit now lives under (a new one when it became version N+1). */
  const save = async (): Promise<string | null> => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/forms/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload()) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setMessage({ ok: false, text: errorText(body) }); return null; }
      if (body.newVersion) {
        setMessage({ ok: true, text: F.savedNewVersion.replace('{n}', String(body.form.version)) });
        router.replace(`/admin/forms/${body.form.id}`);
        return body.form.id;
      }
      setMessage({ ok: true, text: F.saved });
      await load();
      return id;
    } finally {
      setSaving(false);
    }
  };

  const publish = async () => {
    setConfirm(false);
    const target = await save();
    if (!target) return;
    const res = await fetch(`/api/admin/forms/${target}/publish`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { setMessage({ ok: false, text: errorText(body) }); return; }
    setMessage({ ok: true, text: `${F.live} ${F.version.replace('{n}', String(body.form.version))}` });
    if (target === id) await load();
  };

  const diff = useMemo(() => (published ? diffFormVersions(published, payload().fields.map((f) => ({ ...f, helpText: f.helpText ?? undefined, options: f.options ?? undefined }))) : null), [published, fields]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!form) return <Card><SkeletonRows rows={4} /></Card>;
  const isPublished = !!form.publishedAt;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/forms" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-blue-600"><ArrowLeft className="h-4 w-4" />{F.back}</Link>
        <h1 className="mt-2 flex flex-wrap items-center gap-2 text-2xl font-bold text-gray-900 dark:text-gray-100">
          <code>{form.key}</code>
          <Badge variant={isPublished ? 'success' : 'default'} data-testid="form-version-badge">{isPublished ? F.live : F.draft} {F.version.replace('{n}', String(form.version))}</Badge>
        </h1>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          {fields.map((f, i) => (
            <Card key={`${f.id ?? 'new'}-${i}`} data-testid={`builder-field-${i}`}>
              <div className="mb-3 flex flex-wrap items-end gap-2">
                <div className="min-w-[10rem] flex-1">
                  <Input label={F.fieldKey} value={f.key} pattern={FORM_KEY_RE.source} onChange={(e) => set(i, { key: e.target.value.trim() })} id={`builder-key-${i}`} data-testid={`builder-key-${i}`} disabled={!!f.id && isPublished} />
                </div>
                <div className="min-w-[10rem] flex-1">
                  <Select label={F.fieldType} value={f.type} onChange={(e) => set(i, { type: e.target.value as FormFieldType, matchable: false })} options={FORM_FIELD_TYPES.map((x) => ({ value: x, label: F.types[x] }))} disabled={!!f.id && isPublished} data-testid={`builder-type-${i}`} />
                </div>
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={F.moveUp} className="p-2 text-gray-400 hover:text-blue-600 disabled:opacity-30"><ArrowUp className="h-4 w-4" /></button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === fields.length - 1} aria-label={F.moveDown} className="p-2 text-gray-400 hover:text-blue-600 disabled:opacity-30"><ArrowDown className="h-4 w-4" /></button>
                <button type="button" onClick={() => setFields((fs) => fs.filter((_, j) => j !== i))} aria-label={F.remove} className="p-2 text-gray-400 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                {FORM_LOCALES.map((l) => (
                  <Input key={l} label={F.label.replace('{locale}', l.toUpperCase())} value={f.labels[l] ?? ''} maxLength={500} onChange={(e) => set(i, { labels: { ...f.labels, [l]: e.target.value } })} id={`builder-label-${i}-${l}`} data-testid={`builder-label-${i}-${l}`} />
                ))}
                {FORM_LOCALES.map((l) => (
                  <Input key={`h-${l}`} id={`builder-help-${i}-${l}`} label={F.help.replace('{locale}', l.toUpperCase())} value={f.helpText[l] ?? ''} maxLength={500} onChange={(e) => set(i, { helpText: { ...f.helpText, [l]: e.target.value } })} />
                ))}
              </div>
              {looksLikeProtectedProxy(f) && (
                <p className="mt-3 flex items-start gap-2 rounded-lg bg-amber-50 p-2 text-sm text-amber-800" role="note" data-testid={`builder-proxy-warning-${i}`}>
                  <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />{F.proxyWarning}
                </p>
              )}
              {CHOICE(f.type) && (
                <div className="mt-3 space-y-2">
                  <p className="text-sm font-medium text-gray-700 dark:text-gray-200">{F.options}</p>
                  {f.options.map((o, oi) => (
                    <div key={oi} className="grid gap-2 sm:grid-cols-4">
                      <Input label={F.optionValue} value={o.value} onChange={(e) => set(i, { options: f.options.map((x, k) => (k === oi ? { ...x, value: e.target.value.trim() } : x)) })} id={`builder-option-${i}-${oi}-value`} data-testid={`builder-option-${i}-${oi}-value`} />
                      {FORM_LOCALES.map((l) => (
                        <Input key={l} label={F.optionLabel.replace('{locale}', l.toUpperCase())} value={o.labels[l] ?? ''} onChange={(e) => set(i, { options: f.options.map((x, k) => (k === oi ? { ...x, labels: { ...x.labels, [l]: e.target.value } } : x)) })} id={`builder-option-${i}-${oi}-${l}`} data-testid={`builder-option-${i}-${oi}-${l}`} />
                      ))}
                    </div>
                  ))}
                  <Button type="button" size="sm" variant="outline" onClick={() => set(i, { options: [...f.options, { value: `option_${f.options.length + 1}`, labels: {} }] })} data-testid={`builder-add-option-${i}`}>{F.addOption}</Button>
                </div>
              )}
              <div className="mt-3 flex flex-wrap gap-4 text-sm text-gray-700 dark:text-gray-200">
                <label className="flex items-center gap-2"><input type="checkbox" checked={f.required} onChange={(e) => set(i, { required: e.target.checked })} data-testid={`builder-required-${i}`} />{F.required}</label>
                <label className="flex items-center gap-2" title={canBeMatchable(f) ? undefined : F.matchableText}>
                  <input type="checkbox" checked={canBeMatchable(f) && f.matchable} disabled={!canBeMatchable(f)} onChange={(e) => set(i, { matchable: e.target.checked })} data-testid={`builder-matchable-${i}`} />
                  {F.matchable}
                </label>
              </div>
              {!canBeMatchable(f) && <p className="mt-1 text-xs text-gray-500">{F.matchableText}</p>}
            </Card>
          ))}
          <Card>
            <CardHeader><CardTitle>{F.addField}</CardTitle></CardHeader>
            <div className="flex flex-wrap gap-2">
              {FORM_FIELD_TYPES.map((x) => <Button key={x} type="button" size="sm" variant="outline" onClick={() => addField(x)} data-testid={`builder-add-${x}`}>{F.types[x]}</Button>)}
            </div>
          </Card>
          {message && <p role={message.ok ? 'status' : 'alert'} className={message.ok ? 'text-sm text-green-700' : 'text-sm text-red-600'} data-testid="builder-message">{message.text}</p>}
          <div className="flex flex-wrap gap-2">
            <Button onClick={save} loading={saving} data-testid="builder-save">{F.save}</Button>
            <Button variant="outline" onClick={() => setConfirm(true)} disabled={saving || isPublished} data-testid="builder-publish">{F.publish}</Button>
          </div>
        </div>

        <div className="lg:sticky lg:top-4 lg:self-start">
          <Card data-testid="builder-preview">
            <CardHeader><CardTitle>{F.preview}</CardTitle></CardHeader>
            <p className="mb-3 text-sm text-gray-500">{F.previewHint}</p>
            <div className="mb-4 flex flex-wrap items-end gap-3">
              <Select label={F.previewLocale} value={previewLocale} onChange={(e) => setPreviewLocale(e.target.value as Loc)} options={FORM_LOCALES.map((l) => ({ value: l, label: l.toUpperCase() }))} data-testid="builder-preview-locale" />
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showErrors} onChange={(e) => setShowErrors(e.target.checked)} data-testid="builder-preview-errors" />{F.showErrors}</label>
            </div>
            <div className="space-y-4">
              {fields.map((f) => {
                const rendered: RenderedField = { key: f.key, type: f.type, required: f.required, labels: f.labels, helpText: f.helpText, options: CHOICE(f.type) ? f.options : null };
                return <FormFieldInput key={f.key} field={rendered} value={answers[f.key]} onChange={(v) => setAnswers((a) => ({ ...a, [f.key]: v }))} showError={showErrors} locale={previewLocale} testIdPrefix="preview" />;
              })}
            </div>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={confirm}
        title={F.publishTitle.replace('{n}', String(form.version))}
        message={[
          diff ? [
            diff.added.length ? F.diffAdded.replace('{keys}', diff.added.join(', ')) : '',
            diff.removed.length ? F.diffRemoved.replace('{keys}', diff.removed.join(', ')) : '',
            diff.changed.length ? F.diffChanged.replace('{keys}', diff.changed.join(', ')) : '',
          ].filter(Boolean).join(' · ') || F.diffNone : '',
          F.publishKeeps,
        ].filter(Boolean).join(' — ')}
        cancelLabel={t.common.cancel}
        confirmLabel={F.publish}
        loading={saving}
        onConfirm={publish}
        onCancel={() => setConfirm(false)}
      />
    </div>
  );
}
