'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRightCircle, Check, Circle, ListChecks, Plus, Sparkles, Trash2 } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { useT, useLocale } from '@/i18n/client';
import { useRealtime } from '@/hooks/useRealtime';
import { formatDate } from '@/lib/relativeTime';
import { resolveItemText, resolveTemplateText, type AgendaTranslations } from '@/lib/agendasRule';
import { TEXT_LIMITS } from '@/lib/textLimits';

// The session agenda of a mentorship (#1843): what the pair is going to talk
// about, picked from the guide library (#1841) or started empty, ticked live
// by both sides, with the unfinished lines carried into the next session.
//
// Authorization lives in /api/agendas (relation rule + the archived-relation
// lock); `readOnly` and the server's `writable` flag only hide the controls.
// Both seats see the same agenda without polling: every write publishes an
// `agenda` realtime signal for the relation and the panel refetches on it.
//
// The AI proposal (#1845) is a DRAFT: POST /api/agendas/personalize returns
// lines and saves nothing; the seat unticks what does not fit and adds the
// rest through the items endpoint. Every denial comes back as the guide as
// written plus a reason line — never an upgrade prompt, participant AI is free.

interface TemplateOption {
  id: string;
  title: string;
  translations: AgendaTranslations;
  summary: AgendaTranslations;
  useCount: number;
  items: { id: string; prompt: string; translations: AgendaTranslations }[];
}

interface AgendaItem {
  id: string;
  order: number;
  text: string;
  done: boolean;
  doneAt: string | null;
  carried: boolean;
  templateItem: { id: string; prompt: string; translations: AgendaTranslations; guidance: string | null } | null;
}

interface Agenda {
  id: string;
  relationId: string;
  meetingId: string | null;
  templateId: string | null;
  createdAt: string;
  template: { id: string; title: string; translations: AgendaTranslations; archived: boolean } | null;
  items: AgendaItem[];
}

export function AgendaPanel({ relationId, readOnly = false }: { relationId: string; readOnly?: boolean }) {
  const t = useT();
  const locale = useLocale();
  const [agendas, setAgendas] = useState<Agenda[]>([]);
  const [writable, setWritable] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pickedTemplate, setPickedTemplate] = useState('');
  const [newItem, setNewItem] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<{ lines: string[]; picked: boolean[]; source: 'ai' | 'template' | 'empty'; reason: string | null } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/agendas?relationId=${relationId}`, { cache: 'no-store' });
    if (res.ok) {
      const body = await res.json();
      setAgendas(body.agendas ?? []);
      setWritable(body.writable !== false);
    }
    setLoaded(true);
  }, [relationId]);
  useEffect(() => { load(); }, [load]);

  const canWrite = !readOnly && writable;

  useEffect(() => {
    if (!canWrite) return;
    let cancelled = false;
    fetch('/api/agendas/templates')
      .then(async (res) => (res.ok ? (await res.json()).templates ?? [] : []))
      .then((list: TemplateOption[]) => { if (!cancelled) setTemplates(list); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [canWrite]);

  // The other seat ticked something: refetch, no refresh loop needed.
  useRealtime((signal) => {
    if (signal.type === 'tick' || (signal.type === 'agenda' && signal.relationId === relationId)) void load();
  });

  // Newest first from the API; the newest is the current session unless the
  // viewer picked an older one to look back at.
  const current = useMemo(
    () => agendas.find((a) => a.id === selectedId) ?? agendas[0] ?? null,
    [agendas, selectedId]
  );

  const call = async (key: string, url: string, init: RequestInit) => {
    setBusy(key);
    setError('');
    try {
      const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.code === 'inactive_relation' ? t.agenda.archivedHint : body.error ?? t.common.error);
        return null;
      }
      const body = await res.json().catch(() => ({}));
      await load();
      return body;
    } finally {
      setBusy('');
    }
  };

  const start = async () => {
    const body = await call('start', '/api/agendas', {
      method: 'POST',
      body: JSON.stringify({ relationId, templateId: pickedTemplate || undefined }),
    });
    if (body?.agenda?.id) setSelectedId(body.agenda.id);
  };

  const toggle = async (item: AgendaItem) => {
    if (!current) return;
    await call(item.id, `/api/agendas/${current.id}/items/${item.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ done: !item.done }),
    });
  };

  const removeItem = async (item: AgendaItem) => {
    if (!current) return;
    await call(item.id, `/api/agendas/${current.id}/items/${item.id}`, { method: 'DELETE' });
  };

  const addItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!current || !newItem.trim()) return;
    const body = await call('add', `/api/agendas/${current.id}/items`, {
      method: 'POST',
      body: JSON.stringify({ text: newItem.trim() }),
    });
    if (body) setNewItem('');
  };

  const carryOver = async () => {
    if (!current) return;
    const body = await call('carry', `/api/agendas/${current.id}/carry-over`, {
      method: 'POST',
      body: JSON.stringify({ templateId: pickedTemplate || undefined }),
    });
    if (body?.agenda?.id) setSelectedId(body.agenda.id);
  };

  const templateOptions = [
    { value: '', label: t.agenda.startEmpty },
    ...templates.map((tpl) => ({
      value: tpl.id,
      label: `${resolveTemplateText({ text: tpl.title, translations: tpl.translations }, locale)} · ${t.agenda.promptsCount.replace('{n}', String(tpl.items.length))}`,
    })),
  ];

  // A proposal belongs to the session it was asked for.
  const currentId = current?.id ?? null;
  useEffect(() => { setDraft(null); }, [currentId]);

  const suggest = async (regenerate = false) => {
    if (!current) return;
    setBusy('ai');
    setError('');
    try {
      const res = await fetch('/api/agendas/personalize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agendaId: current.id, ...(regenerate ? { regenerate: true } : {}) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.code === 'inactive_relation' ? t.agenda.archivedHint : body.error ?? t.common.error);
        return;
      }
      const lines: string[] = Array.isArray(body.proposals) ? body.proposals.filter((l: unknown) => typeof l === 'string') : [];
      setDraft({ lines, picked: lines.map(() => true), source: body.source === 'template' || body.source === 'empty' ? body.source : 'ai', reason: typeof body.reason === 'string' ? body.reason : null });
    } finally {
      setBusy('');
    }
  };

  const acceptDraft = async () => {
    if (!current || !draft) return;
    const texts = draft.lines.filter((_, i) => draft.picked[i]);
    if (texts.length === 0) {
      setDraft(null);
      return;
    }
    const body = await call('ai-accept', `/api/agendas/${current.id}/items`, { method: 'POST', body: JSON.stringify({ texts }) });
    if (body) setDraft(null);
  };

  const sessionIndex = (agenda: Agenda) => agendas.length - agendas.indexOf(agenda);
  const sessionLabel = (agenda: Agenda) =>
    `${t.agenda.sessionLabel.replace('{n}', String(sessionIndex(agenda)))} · ${formatDate(agenda.createdAt, locale)}`;

  const done = current?.items.filter((i) => i.done).length ?? 0;
  const total = current?.items.length ?? 0;
  const open = total - done;

  const picker = (idSuffix: string) => (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-[220px] flex-1">
        <Select
          id={`agenda-template-${idSuffix}`}
          label={t.agenda.pickGuide}
          value={pickedTemplate}
          options={templateOptions}
          onChange={(e) => setPickedTemplate(e.target.value)}
          data-testid="agenda-template-picker"
        />
      </div>
      <Button type="button" size="sm" loading={busy === 'start'} onClick={start} data-testid="agenda-start">
        <Plus className="h-4 w-4" />
        {pickedTemplate ? t.agenda.startFromGuide : t.agenda.startEmptyAction}
      </Button>
    </div>
  );

  return (
    <Card data-testid="agenda-panel">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>{t.agenda.title}</CardTitle>
          {agendas.length > 1 && (
            <div className="w-56">
              <Select
                aria-label={t.agenda.sessionPicker}
                value={current?.id ?? ''}
                onChange={(e) => setSelectedId(e.target.value)}
                className="py-1.5 pl-3 pr-8"
                options={agendas.map((a) => ({ value: a.id, label: sessionLabel(a) }))}
                data-testid="agenda-session-select"
              />
            </div>
          )}
        </div>
      </CardHeader>

      {!loaded ? null : !current ? (
        <div className="space-y-4">
          <div className="flex items-start gap-3 text-sm text-gray-500">
            <ListChecks className="mt-0.5 h-5 w-5 flex-shrink-0 text-gray-400" aria-hidden="true" />
            <div>
              <p className="font-medium text-gray-700">{t.agenda.noneYet}</p>
              <p className="mt-0.5">{canWrite ? t.agenda.noneYetHint : t.agenda.noneYetReadOnly}</p>
            </div>
          </div>
          {canWrite && picker('first')}
        </div>
      ) : (
        <div className="space-y-4" data-testid="agenda-current">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
            <span className="font-medium text-gray-700" data-testid="agenda-source">
              {current.template
                ? resolveTemplateText({ text: current.template.title, translations: current.template.translations }, locale)
                : t.agenda.adHoc}
            </span>
            {current.template?.archived && <span>· {t.agenda.guideRetired}</span>}
            <span>· {sessionLabel(current)}</span>
            {total > 0 && (
              <span data-testid="agenda-progress">
                · {t.agenda.progress.replace('{done}', String(done)).replace('{total}', String(total))}
              </span>
            )}
          </div>

          {current.items.length === 0 ? (
            <p className="text-sm text-gray-400">{t.agenda.noItems}</p>
          ) : (
            <ul className="space-y-2" data-testid="agenda-items">
              {current.items.map((item) => (
                <li key={item.id} data-testid={`agenda-item-${item.id}`} className="flex items-start gap-2 text-sm">
                  <button
                    type="button"
                    onClick={() => canWrite && toggle(item)}
                    disabled={!canWrite || busy === item.id}
                    aria-label={item.done ? t.agenda.markOpen : t.agenda.markDone}
                    aria-pressed={item.done}
                    data-testid={`agenda-item-toggle-${item.id}`}
                    className={`mt-0.5 ${item.done ? 'text-green-600' : 'text-gray-300 hover:text-gray-500'} disabled:cursor-default`}
                  >
                    {item.done ? <Check className="h-4 w-4" /> : <Circle className="h-4 w-4" />}
                  </button>
                  <span className="min-w-0 flex-1">
                    <span className={item.done ? 'text-gray-400 line-through' : 'text-gray-800'}>
                      {resolveItemText(item, locale)}
                    </span>
                    {item.carried && (
                      <span
                        data-testid="agenda-carried-badge"
                        className="ml-2 inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700"
                      >
                        <ArrowRightCircle className="h-3 w-3" aria-hidden="true" />
                        {t.agenda.carried}
                      </span>
                    )}
                    {item.templateItem?.guidance && (
                      <span className="mt-0.5 block text-xs text-gray-400" data-testid="agenda-guidance">
                        {item.templateItem.guidance}
                      </span>
                    )}
                  </span>
                  {canWrite && (
                    <button
                      type="button"
                      onClick={() => removeItem(item)}
                      disabled={busy === item.id}
                      aria-label={t.common.delete}
                      className="mt-0.5 text-gray-300 hover:text-red-600"
                      data-testid={`agenda-item-delete-${item.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {canWrite && (
            <>
              <form onSubmit={addItem} className="flex flex-wrap items-end gap-2">
                <div className="min-w-[200px] flex-1">
                  <Input
                    label={t.agenda.addLabel}
                    placeholder={t.agenda.addPlaceholder}
                    value={newItem}
                    maxLength={TEXT_LIMITS.agendaItemText}
                    onChange={(e) => setNewItem(e.target.value)}
                    data-testid="agenda-add-input"
                  />
                </div>
                <Button type="submit" size="sm" loading={busy === 'add'} disabled={!newItem.trim()} data-testid="agenda-add">
                  {t.agenda.add}
                </Button>
              </form>

              <div data-testid="agenda-ai">
                {!draft ? (
                  <Button type="button" size="sm" variant="outline" loading={busy === 'ai'} onClick={() => suggest()} data-testid="agenda-ai-suggest">
                    <Sparkles className="h-4 w-4" />
                    {busy === 'ai' ? t.agenda.aiSuggesting : t.agenda.aiSuggest}
                  </Button>
                ) : (
                  <div className="rounded-xl border border-violet-200 bg-violet-50 p-3 text-sm dark:border-violet-900" data-testid="agenda-ai-draft">
                    <p className="font-medium text-gray-800">{t.agenda.aiDraftTitle}</p>
                    {draft.reason && (
                      <p className="mt-1 text-xs text-gray-600" data-testid="agenda-ai-reason">
                        {t.agenda.aiReasons[draft.reason as keyof typeof t.agenda.aiReasons] ?? t.agenda.aiReasons.provider_error}
                      </p>
                    )}
                    {draft.lines.length === 0 ? (
                      <p className="mt-1 text-xs text-gray-600" data-testid="agenda-ai-empty">
                        {draft.source === 'empty' ? t.agenda.aiEmpty : t.agenda.aiNothingNew}
                      </p>
                    ) : (
                      <>
                        <p className="mt-1 text-xs text-gray-500">{t.agenda.aiDraftHint}</p>
                        <ul className="mt-2 space-y-1" data-testid="agenda-ai-lines">
                          {draft.lines.map((line, i) => (
                            <li key={`${i}-${line}`} className="flex items-start gap-2">
                              <input
                                type="checkbox"
                                id={`agenda-ai-line-${i}`}
                                checked={draft.picked[i]}
                                onChange={() => setDraft({ ...draft, picked: draft.picked.map((p, j) => (j === i ? !p : p)) })}
                                className="mt-1 h-4 w-4 rounded border-gray-300"
                                data-testid={`agenda-ai-line-${i}`}
                              />
                              <label htmlFor={`agenda-ai-line-${i}`} className="text-gray-800">{line}</label>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      {draft.lines.length > 0 && (
                        <Button type="button" size="sm" loading={busy === 'ai-accept'} disabled={!draft.picked.some(Boolean)} onClick={acceptDraft} data-testid="agenda-ai-accept">
                          {t.agenda.aiAccept.replace('{n}', String(draft.picked.filter(Boolean).length))}
                        </Button>
                      )}
                      {draft.source === 'ai' && (
                        <Button type="button" size="sm" variant="outline" loading={busy === 'ai'} onClick={() => suggest(true)} data-testid="agenda-ai-regenerate">
                          {t.agenda.aiRegenerate}
                        </Button>
                      )}
                      <Button type="button" size="sm" variant="outline" onClick={() => setDraft(null)} data-testid="agenda-ai-discard">
                        {t.agenda.aiDiscard}
                      </Button>
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-2 border-t border-gray-200 pt-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{t.agenda.nextSession}</p>
                {picker('next')}
                {open > 0 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    loading={busy === 'carry'}
                    onClick={carryOver}
                    data-testid="agenda-carry-over"
                  >
                    <ArrowRightCircle className="h-4 w-4" />
                    {t.agenda.carryOver.replace('{n}', String(open))}
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {!canWrite && loaded && readOnly && current && (
        <p className="mt-3 text-xs text-gray-400">{t.agenda.archivedHint}</p>
      )}
      {error && <p className="mt-2 text-sm text-red-600" role="alert">{error}</p>}
    </Card>
  );
}
