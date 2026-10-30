'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useLocale, useT } from '@/i18n/client';
import { FORM_AUDIENCES, FORM_SURFACES, FORM_KEY_RE, liveVersion } from '@/lib/forms/definitionRule';
import { localized } from '@/components/forms/FormFieldInput';

// The programme's admin-defined forms (#1802): one row per form key, its live
// and newest versions, and the way into the builder. The rules live in
// src/lib/forms/definitions.ts; this page only lists and creates.

interface FormRow {
  id: string;
  key: string;
  audience: string;
  surface: string;
  version: number;
  title: Record<string, string> | null;
  publishedAt: string | null;
  archivedAt: string | null;
  _count: { fields: number; responses: number };
}

export default function AdminFormsPage() {
  const t = useT();
  const F = t.formsAdmin;
  const locale = useLocale();
  const router = useRouter();
  const [rows, setRows] = useState<FormRow[] | null>(null);
  const [key, setKey] = useState('');
  const [audience, setAudience] = useState<string>('MENTEE');
  const [surface, setSurface] = useState<string>('REGISTRATION');
  const [title, setTitle] = useState({ en: '', tr: '', de: '' });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/forms');
    setRows(res.ok ? (await res.json()).forms : []);
  }, []);
  useEffect(() => { load(); }, [load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const titleBody = Object.fromEntries(Object.entries(title).filter(([, v]) => v.trim()));
      const res = await fetch('/api/admin/forms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, audience, surface, title: Object.keys(titleBody).length ? titleBody : null, fields: [] }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(F.errors[body.code as keyof typeof F.errors]?.replace('{key}', key) ?? F.errors.generic);
        return;
      }
      router.push(`/admin/forms/${body.form.id}`);
    } finally {
      setSaving(false);
    }
  };

  const byKey = new Map<string, FormRow[]>();
  for (const r of rows ?? []) byKey.set(r.key, [...(byKey.get(r.key) ?? []), r]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{F.title}</h1>
        <p className="mt-1 text-gray-500">{F.subtitle}</p>
      </div>

      <Card>
        <CardHeader><CardTitle>{F.newForm}</CardTitle></CardHeader>
        <form onSubmit={create} className="grid gap-3 sm:grid-cols-3" data-testid="form-create">
          <Input id="form-create-key" label={F.key} hint={F.keyHint} value={key} onChange={(e) => setKey(e.target.value.trim())} required pattern={FORM_KEY_RE.source} data-testid="form-create-key" />
          <Select label={F.audience} value={audience} onChange={(e) => setAudience(e.target.value)} options={FORM_AUDIENCES.map((a) => ({ value: a, label: F.audiences[a] }))} />
          <Select label={F.surface} value={surface} onChange={(e) => setSurface(e.target.value)} options={FORM_SURFACES.map((s) => ({ value: s, label: F.surfaces[s] }))} data-testid="form-create-surface" />
          {(['en', 'tr', 'de'] as const).map((l) => (
            <Input key={l} id={`form-create-title-${l}`} label={F.formTitle.replace('{locale}', l.toUpperCase())} value={title[l]} maxLength={500} onChange={(e) => setTitle((x) => ({ ...x, [l]: e.target.value }))} />
          ))}
          {error && <p role="alert" className="text-sm text-red-600 sm:col-span-3">{error}</p>}
          <div className="sm:col-span-3"><Button type="submit" loading={saving} data-testid="form-create-submit">{F.create}</Button></div>
        </form>
      </Card>

      <Card>
        {rows === null ? <SkeletonRows rows={3} /> : byKey.size === 0 ? (
          <p className="py-8 text-center text-gray-400">{F.none}</p>
        ) : (
          <ul className="divide-y divide-gray-100" data-testid="form-list">
            {[...byKey.entries()].map(([k, versions]) => {
              const newest = versions.reduce((a, b) => (b.version > a.version ? b : a));
              const live = liveVersion(versions);
              return (
                <li key={k} className="flex flex-wrap items-center gap-3 py-3" data-testid={`form-row-${k}`}>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-gray-900 dark:text-gray-100">{localized(newest.title, locale) || k}</p>
                    <p className="text-sm text-gray-500">
                      <code>{k}</code> · {F.surfaces[newest.surface as keyof typeof F.surfaces] ?? newest.surface} · {F.audiences[newest.audience as keyof typeof F.audiences] ?? newest.audience} · {F.fields.replace('{n}', String(newest._count.fields))}
                    </p>
                  </div>
                  {live && <Badge variant="success">{F.live} {F.version.replace('{n}', String(live.version))}</Badge>}
                  {!newest.publishedAt && <Badge variant="default">{F.draft} {F.version.replace('{n}', String(newest.version))}</Badge>}
                  <Link href={`/admin/forms/${newest.id}`} className="text-sm text-blue-600 hover:underline" data-testid={`form-open-${k}`}>{F.open}</Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
