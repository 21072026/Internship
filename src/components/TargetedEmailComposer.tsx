'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import { useT, useLocale } from '@/i18n/client';
import { LanguageBadge, languageBreakdown } from '@/components/LanguageBadge';
import { PersonHoverCard } from '@/components/PersonHoverCard';
import { Sparkles, UserRound } from 'lucide-react';
import { locales, type Locale } from '@/i18n/config';
import { getDictionary } from '@/i18n/dictionaries';
import { BULK_DRAFT_MAX_RECIPIENTS } from '@/lib/outreachRules';
import { useFilterAnnouncement, resultCountMessage } from '@/hooks/useFilterAnnouncement';

interface EmailDraft {
  subject: string;
  body: string;
}

// The outcome templates (#830) sit at the end: they are the ones a mentor is
// sent here to write, and the ones nobody should reach for by accident.
const TEMPLATE_KEYS = [
  'welcome', 'checkin', 'interview', 'followup',
  'outcomeNoMatch', 'outcomePlacedElsewhere', 'outcomePoolInvite',
] as const;

const emptyDraft = (): EmailDraft => ({ subject: '', body: '' });
const blankDrafts = () =>
  Object.fromEntries(locales.map((l) => [l, emptyDraft()])) as Record<Locale, EmailDraft>;
const isWritten = (draft: EmailDraft) => !!draft.subject.trim() && !!draft.body.trim();

// The composer's own narrow read (#1438): GET /api/mentorship?view=recipients
// answers a relation id and its mentee's name and language — nothing else.
interface Relation {
  id: string;
  mentee: { id: string; fullName: string; preferredLanguage?: string | null };
}

// Targeted email composer shared by the mentor (/mentor/email) and admin
// (/admin/email) screens — admin ⊇ mentor parity (#708). Fetches the caller's
// mentorship relations (admin gets all) and posts to /api/mentor/email, which
// already authorizes ADMIN and respects each recipient's email opt-out.
export function TargetedEmailComposer() {
  const t = useT();
  const locale = useLocale();
  // One page of the recipient list at a time, searched on the server (#1438):
  // a programme of a thousand mentees used to download and render all of them.
  const [relations, setRelations] = useState<Relation[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [serverSearch, setServerSearch] = useState('');
  const [listLoading, setListLoading] = useState(false);
  // The pick, keyed by relation id, kept with what the screen shows for it — so
  // a recipient stays picked (and counted, and in the language mix) after the
  // search moves on to other people.
  const [selected, setSelected] = useState<Record<string, Relation>>({});
  // "Select all" means every match of the search it was ticked under, not the
  // rows that happen to be loaded; the ids are kept so unticking undoes it.
  const [allFor, setAllFor] = useState<{ search: string; ids: string[] } | null>(null);
  // One message, up to three languages (#1165). The ready-made templates already
  // exist in EN/TR/DE, but only the sender's locale was ever used — so a group of
  // mentees who do not all read the same language got whichever one the sender's
  // UI happened to be in.
  const [drafts, setDrafts] = useState<Record<Locale, EmailDraft>>(blankDrafts);
  const [tab, setTab] = useState<Locale>(locale);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  // Arrived from an outcome notification (#830): ?relation=<id>&template=<key>.
  // The composer is the *preview* step — it fills the draft and ticks the one
  // recipient, then stops. Nothing is sent until the mentor presses send, which
  // is the whole point: a rejection is the most sensitive text this product
  // writes, and the wrong message on the wrong case cannot be recalled.
  const params = useSearchParams();
  const prefillRelation = params.get('relation');
  const prefillTemplate = params.get('template');
  // AI drafts (#2048, part 2). One bulk draft is ONE provider call for every
  // ticked recipient, personalised by {name}; the cost is stated before the
  // button, and above the cap the button is off (the server refuses too). An
  // AI draft fills the editor and is marked until edited — sending stays this
  // screen's Send button, pressed by a person.
  const [aiPurpose, setAiPurpose] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiFilled, setAiFilled] = useState<{ locale: Locale; draft: EmailDraft } | null>(null);

  const recipientsUrl = useCallback(
    (extra: Record<string, string>) => {
      const params = new URLSearchParams({ view: 'recipients', ...extra });
      if (serverSearch) params.set('search', serverSearch);
      return `/api/mentorship?${params}`;
    },
    [serverSearch]
  );

  useEffect(() => {
    const id = setTimeout(() => setServerSearch(search.trim()), 250);
    return () => clearTimeout(id);
  }, [search]);

  const load = useCallback(
    async (nextPage: number) => {
      setListLoading(true);
      try {
        const res = await fetch(recipientsUrl({ page: String(nextPage) }));
        const data = await res.json();
        const rows = (data.recipients ?? []) as Relation[];
        setRelations((prev) => (nextPage === 1 ? rows : [...prev, ...rows.filter((r) => !prev.some((p) => p.id === r.id))]));
        setTotal(typeof data.total === 'number' ? data.total : rows.length);
        setPage(nextPage);
      } finally {
        setListLoading(false);
      }
    },
    [recipientsUrl]
  );

  useEffect(() => {
    load(1);
  }, [load]);

  // The search box re-filters the list in place and moves no focus, so a
  // screen reader hears how many recipients it left (WCAG 4.1.3).
  useFilterAnnouncement(serverSearch && !listLoading ? resultCountMessage(t.a11y, total) : null);

  const chosenRelations = Object.values(selected);
  const chosen = chosenRelations.map((r) => r.id);
  const allChecked = total > 0 && allFor?.search === serverSearch;

  const toggleAll = async (on: boolean) => {
    if (!on) {
      const ids = new Set(allFor?.ids ?? relations.map((r) => r.id));
      setSelected((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => !ids.has(id))));
      setAllFor(null);
      return;
    }
    // Ticked at once; the ids follow, and a failed read unticks it again.
    const forSearch = serverSearch;
    setAllFor({ search: forSearch, ids: [] });
    try {
      const res = await fetch(recipientsUrl({ all: '1' }));
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      const rows = (data.recipients ?? []) as Relation[];
      setSelected((prev) => ({ ...prev, ...Object.fromEntries(rows.map((r) => [r.id, r])) }));
      setAllFor({ search: forSearch, ids: rows.map((r) => r.id) });
    } catch {
      setAllFor(null);
    }
  };
  // One body goes to everyone selected, so the sender should see the languages
  // they are about to write across before they start typing (#1164).
  const breakdown = languageBreakdown(chosenRelations.map((r) => r.mentee.preferredLanguage));

  // Only complete languages travel: a subject with no body (or the reverse)
  // would go out as a broken email, so it is left out and those recipients fall
  // back to a language that was finished.
  const written = locales.filter((l) => isWritten(drafts[l]));

  // Picking a template fills EVERY language at once, not just the one on screen
  // — the whole point is that the sender does not hand-translate.
  const applyTemplate = (key: string) => {
    setDrafts((prev) => {
      const next = { ...prev };
      for (const l of locales) {
        const tpl = (getDictionary(l).emailTemplates as Record<string, EmailDraft>)[key];
        if (tpl) next[l] = { subject: tpl.subject, body: tpl.body };
      }
      return next;
    });
  };

  // Asked for by id, and only for a relation the caller actually has — the
  // server's scope answers, so a stale or foreign id simply prefills nothing.
  // Not read off the loaded page: the relation may sit on any page (#1438).
  useEffect(() => {
    if (!prefillRelation) return;
    let cancelled = false;
    fetch(`/api/mentorship?${new URLSearchParams({ view: 'recipients', relation: prefillRelation })}`)
      .then((r) => (r.ok ? r.json() : { recipients: [] }))
      .then((data) => {
        const row = ((data.recipients ?? []) as Relation[]).find((r) => r.id === prefillRelation);
        if (cancelled || !row) return;
        setSelected({ [row.id]: row });
        if (prefillTemplate && (TEMPLATE_KEYS as readonly string[]).includes(prefillTemplate)) {
          applyTemplate(prefillTemplate);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // applyTemplate is a stable local.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillRelation, prefillTemplate]);

  const patchDraft = (patch: Partial<EmailDraft>) =>
    setDrafts((prev) => ({ ...prev, [tab]: { ...prev[tab], ...patch } }));

  const aiFailure = (code: string | undefined) => {
    const A = t.messages.ai;
    return code === 'feature_locked' ? t.organizations.featureLocked
      : code === 'consent_required' ? A.consentRequired
      : code === 'quota_exceeded' ? A.quotaExceeded
      : code === 'disabled' ? A.aiOff
        : code === 'provider_error' ? A.providerError
          : code === 'not_configured' ? A.notConfigured
            : code === 'batch_too_large' ? t.mentorEmail.ai.tooMany.replace('{max}', String(BULK_DRAFT_MAX_RECIPIENTS))
              : A.failed;
  };
  const fillFromAi = (locale: Locale, draft: EmailDraft) => {
    setDrafts((prev) => ({ ...prev, [locale]: draft }));
    setTab(locale);
    setAiFilled({ locale, draft });
  };

  const draftBulk = async () => {
    setAiBusy(true);
    setAiError(null);
    try {
      const res = await fetch('/api/ai/bulk-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purpose: aiPurpose.trim(), recipientCount: chosen.length, locale: tab }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setAiError(aiFailure(data.code)); return; }
      fillFromAi(tab, { subject: data.draft?.subject ?? '', body: data.draft?.body ?? '' });
    } catch {
      setAiError(aiFailure(undefined));
    } finally {
      setAiBusy(false);
    }
  };

  // The outcome note for the one relation this screen was opened for (#830):
  // grounded in that relation, written in the mentee's language.
  const outcomeRelation = prefillRelation && prefillTemplate?.startsWith('outcome') && chosen.length === 1 && chosen[0] === prefillRelation ? prefillRelation : null;
  const draftOutcome = async () => {
    if (!outcomeRelation) return;
    setAiBusy(true);
    setAiError(null);
    try {
      const res = await fetch(`/api/mentorship/${encodeURIComponent(outcomeRelation)}/ai-draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ moment: 'outcome_note' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setAiError(aiFailure(data.code)); return; }
      const locale = (locales as readonly string[]).includes(data.locale) ? (data.locale as Locale) : tab;
      fillFromAi(locale, { subject: data.draft?.subject || drafts[locale].subject, body: data.draft?.body ?? '' });
    } catch {
      setAiError(aiFailure(undefined));
    } finally {
      setAiBusy(false);
    }
  };
  const aiUnedited = aiFilled !== null && aiFilled.locale === tab && drafts[tab].subject === aiFilled.draft.subject && drafts[tab].body === aiFilled.draft.body;
  const tooMany = chosen.length > BULK_DRAFT_MAX_RECIPIENTS;

  const send = async () => {
    setSending(true);
    setResult(null);
    try {
      const translations = Object.fromEntries(written.map((l) => [l, drafts[l]]));
      const res = await fetch('/api/mentor/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relationIds: chosen, translations }),
      });
      const data = await res.json();
      if (res.ok) {
        setResult(t.mentorEmail.sentCount.replace('{n}', String(data.sent)));
        setDrafts(blankDrafts());
        setSelected({});
        setAllFor(null);
      } else {
        setResult(data.error || 'Failed');
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.mentorEmail.title}</h1>
        <p className="text-gray-500 mt-1">{t.mentorEmail.subtitle}</p>
      </div>

      {result && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">{result}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>{t.mentorEmail.recipients} ({chosen.length}/{total})</CardTitle>
          </CardHeader>
          {total === 0 && !serverSearch && !listLoading ? (
            <p className="text-sm text-gray-400">{t.mentor.noMenteesAssigned}</p>
          ) : (
            <div className="space-y-1">
              <input
                type="search"
                data-testid="email-recipient-search"
                aria-label={t.mentorEmail.searchRecipients}
                placeholder={t.mentorEmail.searchRecipients}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="mb-2 w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
              />
              <label className="flex items-center gap-2 text-sm font-medium pb-2 border-b border-gray-100">
                <input
                  type="checkbox"
                  data-testid="email-recipient-select-all"
                  checked={allChecked}
                  disabled={total === 0}
                  onChange={(e) => toggleAll(e.target.checked)}
                />
                {t.mentorEmail.selectAll} ({total})
              </label>
              {relations.map((r) => (
                <label key={r.id} className="flex items-center gap-2 text-sm py-1">
                  <input
                    type="checkbox"
                    checked={!!selected[r.id]}
                    onChange={(e) => {
                      const on = e.target.checked;
                      setSelected((p) => {
                        const next = { ...p };
                        if (on) next[r.id] = r;
                        else delete next[r.id];
                        return next;
                      });
                      if (!on) setAllFor(null);
                    }}
                  />
                  <span className="truncate">{r.mentee.fullName}</span>
                  {/* Clicking the NAME here ticks the box, so the card hangs off
                      its own icon instead — the selection gesture is untouched
                      and the card still opens on hover/tap/focus (#1166). */}
                  <PersonHoverCard
                    personId={r.mentee.id}
                    role="MENTEE"
                    className="no-underline inline-flex h-6 w-6 shrink-0 items-center justify-center"
                  >
                    <UserRound className="h-3.5 w-3.5 text-gray-400 hover:text-blue-600" aria-hidden />
                  </PersonHoverCard>
                  <LanguageBadge language={r.mentee.preferredLanguage} className="ml-auto" />
                </label>
              ))}
              {relations.length < total && (
                <button
                  type="button"
                  data-testid="email-recipient-more"
                  disabled={listLoading}
                  onClick={() => load(page + 1)}
                  className="mt-2 w-full rounded-lg border border-dashed border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 hover:border-blue-300 hover:text-blue-700 disabled:opacity-60"
                >
                  {t.board.loadMore.replace('{shown}', String(relations.length)).replace('{total}', String(total))}
                </button>
              )}
            </div>
          )}
          {breakdown.length > 0 && (
            <div
              data-testid="recipient-languages"
              className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3 text-xs text-gray-500"
            >
              <span>{t.languageBadge.recipients}</span>
              {breakdown.map(({ locale, count }) => (
                <span key={locale} className="inline-flex items-center gap-1">
                  <LanguageBadge language={locale} />
                  <span>×{count}</span>
                </span>
              ))}
            </div>
          )}
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t.mentorEmail.compose}</CardTitle>
          </CardHeader>
          <div className="space-y-4">
            <div className="rounded-lg border border-violet-200 bg-violet-50 p-3 dark:border-violet-900" data-testid="bulk-draft-panel">
              <p className="mb-2 inline-flex items-center gap-1.5 text-sm font-medium text-violet-800">
                <Sparkles className="h-4 w-4" aria-hidden /> {t.mentorEmail.ai.title}
              </p>
              {outcomeRelation ? (
                <Button type="button" size="sm" variant="outline" onClick={() => void draftOutcome()} loading={aiBusy} data-testid="outcome-ai-draft">
                  {t.mentorEmail.ai.outcomeDraft}
                </Button>
              ) : (
                <>
                  <Input
                    label={t.mentorEmail.ai.purpose}
                    value={aiPurpose}
                    onChange={(e) => setAiPurpose(e.target.value)}
                    placeholder={t.mentorEmail.ai.purposePlaceholder}
                    maxLength={500}
                    data-testid="bulk-draft-purpose"
                  />
                  <p className="mt-1.5 text-xs text-violet-800" data-testid="bulk-draft-cost">
                    {chosen.length === 0
                      ? t.mentorEmail.ai.noRecipients
                      : tooMany
                        ? t.mentorEmail.ai.tooMany.replace('{max}', String(BULK_DRAFT_MAX_RECIPIENTS))
                        : t.mentorEmail.ai.cost.replace('{n}', String(chosen.length))}
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    onClick={() => void draftBulk()}
                    loading={aiBusy}
                    disabled={chosen.length === 0 || tooMany || aiPurpose.trim().length < 3}
                    data-testid="bulk-draft-button"
                  >
                    {t.mentorEmail.ai.draft}
                  </Button>
                </>
              )}
              {aiError && <p className="mt-2 text-xs text-red-600" role="alert" data-testid="bulk-draft-error">{aiError}</p>}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t.mentorEmail.template}</label>
              <select
                id="email-template"
                defaultValue=""
                data-testid="email-template-select"
                onChange={(e) => {
                  if (e.target.value) applyTemplate(e.target.value);
                  e.target.value = '';
                }}
                className="block w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm focus:border-blue-400 focus:ring-2 focus:ring-blue-100 focus:outline-none"
              >
                <option value="">{t.mentorEmail.templatePlaceholder}</option>
                {TEMPLATE_KEYS.map((k) => (
                  <option key={k} value={k}>{(t.emailTemplates as Record<string, { label: string }>)[k]?.label ?? k}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium text-gray-700">{t.mentorEmail.languages}</span>
              <div className="flex gap-1" role="tablist">
                {locales.map((l) => (
                  <button
                    key={l}
                    type="button"
                    role="tab"
                    aria-selected={tab === l}
                    data-testid={`email-tab-${l}`}
                    data-filled={isWritten(drafts[l]) ? 'true' : 'false'}
                    onClick={() => setTab(l)}
                    className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold uppercase ${
                      tab === l
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:!bg-gray-800 dark:!text-gray-300'
                    }`}
                  >
                    {l}
                    <span
                      aria-hidden
                      className={`h-1.5 w-1.5 rounded-full ${
                        isWritten(drafts[l])
                          ? tab === l ? 'bg-white' : 'bg-green-500'
                          : 'bg-transparent border border-current opacity-40'
                      }`}
                    />
                  </button>
                ))}
              </div>
            </div>
            <Input
              label={t.mentorEmail.subject}
              data-testid="email-subject"
              value={drafts[tab].subject}
              onChange={(e) => patchDraft({ subject: e.target.value })}
            />
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t.mentorEmail.message}</label>
              <Textarea
                rows={8}
                aria-label={t.mentorEmail.message}
                data-testid="email-body"
                value={drafts[tab].body}
                onChange={(e) => patchDraft({ body: e.target.value })}
                maxLength={10000}
                showCounter
              />
            </div>
            {aiUnedited && (
              <p className="text-xs text-violet-700" data-testid="email-ai-draft-badge">✨ {t.mentorEmail.ai.draftBadge}</p>
            )}
            {/* Which of the ticked recipients this actually covers, and who
                falls back — the sender should not have to cross-reference the
                recipient list against the tabs by hand. */}
            {written.length > 0 && (
              <p data-testid="email-language-coverage" className="text-xs text-gray-500">
                {t.mentorEmail.writtenIn.replace('{langs}', written.map((l) => l.toUpperCase()).join(', '))}
                {breakdown.some(({ locale: l }) => !written.includes(l)) &&
                  ` ${t.mentorEmail.fallbackTo.replace('{lang}', (written[0] ?? '').toUpperCase())}`}
              </p>
            )}
            <Button onClick={send} loading={sending} disabled={chosen.length === 0 || written.length === 0}>
              {t.mentorEmail.send}
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
