'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { fillTemplate } from '@/components/ui/fillTemplate';
import { useT, useLocale } from '@/i18n/client';
import { locales, type Locale } from '@/i18n/config';
import type { EmailGroupId } from '@/lib/emailGroups';

// The notification template editor (#1719, data #1718, docs/notification-templates.md).
//
// Every event whose mail can be edited, per language: a subject and a body,
// the merge tags the event carries, a live preview rendered by the SAME
// function that sends the real mail (POST …/preview → renderNotificationEmail),
// a test send to the admin's own address, and a reset to the shipped default.
// The preview is shown in a fully sandboxed iframe (no allow-* token) — the
// body is admin-written and was only ever trusted after the server sanitised it.

type LocaleState = {
  source: 'program' | 'org' | 'default';
  overridden: boolean;
  subject: string | null;
  body: string | null;
  defaultSubject: string;
  defaultBody: string;
  updatedAt: string | null;
  updatedBy: string | null;
};
type EventRow = { key: string; tags: string[]; locales: Record<Locale, LocaleState> };
type Group = { group: EmailGroupId; events: EventRow[] };
type Program = { id: string; name: string };

const LANGUAGE_NAMES: Record<Locale, string> = { en: 'English', tr: 'Türkçe', de: 'Deutsch' };

export default function NotificationTemplatesPage() {
  const t = useT();
  const n = t.notificationTemplates;
  const uiLocale = useLocale();
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [programId, setProgramId] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [lang, setLang] = useState<Locale>(uiLocale);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  const load = useCallback(async (pid: string) => {
    const res = await fetch(`/api/admin/notification-templates${pid ? `?programId=${encodeURIComponent(pid)}` : ''}`);
    if (!res.ok) return;
    const d = await res.json();
    setGroups(d.groups);
    setPrograms(d.programs ?? []);
  }, []);
  useEffect(() => {
    void load(programId);
  }, [load, programId]);

  const event = useMemo(() => groups?.flatMap((g) => g.events).find((e) => e.key === selected) ?? null, [groups, selected]);
  const state = event?.locales[lang] ?? null;

  // Load the editor fields whenever the event, the language or the stored copy
  // changes (a save or a reset reloads the list, and the fields follow it).
  useEffect(() => {
    if (!state) return;
    setSubject(state.subject ?? state.defaultSubject);
    setBody(state.body ?? state.defaultBody);
  }, [state]);
  // A status line belongs to the event and language it was about — not to the
  // list reload that follows a save, which must not wipe "Saved." again.
  useEffect(() => {
    setMessage(null);
  }, [selected, lang, programId]);

  // Live preview, debounced; the server renders it with the real renderer.
  useEffect(() => {
    if (!event) return;
    const id = setTimeout(async () => {
      const res = await fetch('/api/admin/notification-templates/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventKey: event.key, locale: lang, subject, body }),
      }).catch(() => null);
      if (res?.ok) setPreview(await res.json());
    }, 400);
    return () => clearTimeout(id);
  }, [event, lang, subject, body]);

  const write = async (method: 'PUT' | 'DELETE') => {
    if (!event) return;
    setBusy(true);
    setMessage(null);
    try {
      const q = new URLSearchParams({ eventKey: event.key, locale: lang, ...(programId ? { programId } : {}) });
      const res =
        method === 'PUT'
          ? await fetch('/api/admin/notification-templates', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ eventKey: event.key, locale: lang, subject, body, ...(programId ? { programId } : {}) }),
            })
          : await fetch(`/api/admin/notification-templates?${q}`, { method: 'DELETE' });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        setMessage(d?.code ? (n.refusals as Record<string, string>)[d.code] ?? n.failed : n.failed);
        return;
      }
      setMessage(method === 'PUT' ? n.saved : n.resetDone);
      await load(programId);
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    if (!event) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/notification-templates/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventKey: event.key, locale: lang, subject, body }),
      });
      const d = await res.json().catch(() => null);
      setMessage(res.ok && d?.ok ? n.testSent : n.testFailed);
    } finally {
      setBusy(false);
    }
  };

  const insertTag = (tag: string) => {
    const el = bodyRef.current;
    const token = `{{${tag}}}`;
    if (!el) return setBody((b) => b + token);
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    setBody(body.slice(0, start) + token + body.slice(end));
  };

  const label = (e: EventRow) => e.locales[uiLocale]?.defaultSubject || e.key;
  const anyOverride = (e: EventRow) => locales.some((l) => e.locales[l].overridden);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{n.title}</h1>
        <p className="text-sm text-gray-600 dark:text-gray-300">{n.subtitle}</p>
      </div>

      {programs.length > 0 && (
        <label className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-gray-500 dark:text-gray-400">{n.scope}:</span>
          <select
            value={programId}
            onChange={(e) => setProgramId(e.target.value)}
            className="rounded-lg border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-800"
            data-testid="templates-scope"
          >
            <option value="">{n.scopeOrg}</option>
            {programs.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Card>
          <CardHeader>
            <CardTitle>{n.events}</CardTitle>
          </CardHeader>
          {!groups ? (
            <p className="text-sm text-gray-500">{n.loading}</p>
          ) : (
            <div className="space-y-4" data-testid="templates-list">
              {groups.map((g) => (
                <div key={g.group}>
                  <h3 className="mb-1 text-xs font-semibold uppercase text-gray-500 dark:text-gray-400">
                    {(t.emailGroups as Record<string, { name: string }>)[g.group]?.name ?? g.group}
                  </h3>
                  <ul className="space-y-1">
                    {g.events.map((e) => (
                      <li key={e.key}>
                        <button
                          type="button"
                          onClick={() => setSelected(e.key)}
                          aria-pressed={selected === e.key}
                          data-testid={`template-event-${e.key}`}
                          className={`w-full rounded-lg px-2 py-1 text-left text-sm ${selected === e.key ? 'bg-blue-50 text-blue-700' : 'hover:bg-gray-50 dark:hover:bg-gray-800'}`}
                        >
                          {label(e)}
                          {anyOverride(e) && (
                            <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">{n.customized}</span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          {!event || !state ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">{n.pickEvent}</p>
          ) : (
            <div className="space-y-4" data-testid="template-editor">
              <CardHeader>
                <CardTitle>{label(event)}</CardTitle>
                <CardDescription>
                  {state.overridden && state.updatedAt ? (
                    <span data-testid="template-overridden">
                      {fillTemplate(n.changedBy, {
                        who: state.updatedBy ?? n.someone,
                        when: <RelativeTime date={state.updatedAt} locale={uiLocale} />,
                      })}
                    </span>
                  ) : state.source === 'org' ? (
                    n.inheritsOrg
                  ) : (
                    n.usingDefault
                  )}
                </CardDescription>
              </CardHeader>
              <div className="flex flex-wrap gap-2 text-sm" role="group" aria-label={n.language}>
                {locales.map((l) => (
                  <button
                    key={l}
                    type="button"
                    aria-pressed={lang === l}
                    onClick={() => setLang(l)}
                    data-testid={`template-lang-${l}`}
                    className={`rounded-lg border px-3 py-1 ${lang === l ? 'border-blue-600 bg-blue-50 text-blue-700 font-medium' : 'border-gray-300 text-gray-700'}`}
                  >
                    {LANGUAGE_NAMES[l]}
                    {event.locales[l].overridden ? ' •' : ''}
                  </button>
                ))}
              </div>
              <Input id="template-subject" label={n.subject} value={subject} onChange={(e) => setSubject(e.target.value)} data-testid="template-subject" maxLength={255} />
              <label htmlFor="template-body" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                {n.body}
              </label>
              <Textarea
                id="template-body"
                ref={bodyRef}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={8}
                data-testid="template-body"
              />
              <div className="text-sm">
                <div className="mb-1 text-xs text-gray-500 dark:text-gray-400">{n.tags}</div>
                <div className="flex flex-wrap gap-1" data-testid="template-tags">
                  {event.tags.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => insertTag(tag)}
                      className="rounded border border-gray-300 px-1.5 py-0.5 font-mono text-xs dark:border-gray-600"
                      data-testid={`template-tag-${tag}`}
                    >
                      {`{{${tag}}}`}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{n.htmlNote}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" loading={busy} onClick={() => write('PUT')} data-testid="template-save">
                  {n.save}
                </Button>
                <Button type="button" variant="outline" disabled={busy} onClick={sendTest} data-testid="template-test">
                  {n.sendTest}
                </Button>
                <Button type="button" variant="outline" disabled={busy || !state.overridden} onClick={() => write('DELETE')} data-testid="template-reset">
                  {n.reset}
                </Button>
                {message && (
                  <span role="status" className="text-sm text-gray-600 dark:text-gray-300" data-testid="template-message">
                    {message}
                  </span>
                )}
              </div>
              <div>
                <div className="mb-1 text-xs font-medium text-gray-500 dark:text-gray-400">{n.preview}</div>
                {preview && (
                  <>
                    <p className="mb-2 text-sm" data-testid="template-preview-subject">
                      <span className="text-gray-500">{n.subject}: </span>
                      {preview.subject}
                    </p>
                    <iframe
                      title={n.preview}
                      srcDoc={preview.html}
                      // Fully sandboxed: no allow-* token, so the document has an
                      // opaque origin and runs no script, form or navigation.
                      sandbox=""
                      className="h-96 w-full rounded-lg border border-gray-200 bg-white dark:border-gray-700"
                      data-testid="template-preview"
                    />
                  </>
                )}
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
