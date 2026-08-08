'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import { useT, useLocale } from '@/i18n/client';
import { LanguageBadge, languageBreakdown } from '@/components/LanguageBadge';
import { locales, type Locale } from '@/i18n/config';
import { getDictionary } from '@/i18n/dictionaries';

interface EmailDraft {
  subject: string;
  body: string;
}

const TEMPLATE_KEYS = ['welcome', 'checkin', 'interview', 'followup'] as const;

const emptyDraft = (): EmailDraft => ({ subject: '', body: '' });
const blankDrafts = () =>
  Object.fromEntries(locales.map((l) => [l, emptyDraft()])) as Record<Locale, EmailDraft>;
const isWritten = (draft: EmailDraft) => !!draft.subject.trim() && !!draft.body.trim();

interface Relation {
  id: string;
  mentee: { fullName: string; email: string; preferredLanguage?: string | null };
}

// Targeted email composer shared by the mentor (/mentor/email) and admin
// (/admin/email) screens — admin ⊇ mentor parity (#708). Fetches the caller's
// mentorship relations (admin gets all) and posts to /api/mentor/email, which
// already authorizes ADMIN and respects each recipient's email opt-out.
export function TargetedEmailComposer() {
  const t = useT();
  const locale = useLocale();
  const [relations, setRelations] = useState<Relation[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  // One message, up to three languages (#1165). The ready-made templates already
  // exist in EN/TR/DE, but only the sender's locale was ever used — so a group of
  // mentees who do not all read the same language got whichever one the sender's
  // UI happened to be in.
  const [drafts, setDrafts] = useState<Record<Locale, EmailDraft>>(blankDrafts);
  const [tab, setTab] = useState<Locale>(locale);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/mentorship');
    const data = await res.json();
    setRelations(data.relations ?? []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const chosenRelations = relations.filter((r) => selected[r.id]);
  const chosen = chosenRelations.map((r) => r.id);
  const allChecked = relations.length > 0 && chosen.length === relations.length;
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

  const patchDraft = (patch: Partial<EmailDraft>) =>
    setDrafts((prev) => ({ ...prev, [tab]: { ...prev[tab], ...patch } }));

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
            <CardTitle>{t.mentorEmail.recipients} ({chosen.length}/{relations.length})</CardTitle>
          </CardHeader>
          {relations.length === 0 ? (
            <p className="text-sm text-gray-400">{t.mentor.noMenteesAssigned}</p>
          ) : (
            <div className="space-y-1">
              <label className="flex items-center gap-2 text-sm font-medium pb-2 border-b border-gray-100">
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={(e) =>
                    setSelected(e.target.checked ? Object.fromEntries(relations.map((r) => [r.id, true])) : {})
                  }
                />
                {t.mentorEmail.selectAll}
              </label>
              {relations.map((r) => (
                <label key={r.id} className="flex items-center gap-2 text-sm py-1">
                  <input
                    type="checkbox"
                    checked={!!selected[r.id]}
                    onChange={(e) => setSelected((p) => ({ ...p, [r.id]: e.target.checked }))}
                  />
                  <span className="truncate">{r.mentee.fullName}</span>
                  <LanguageBadge language={r.mentee.preferredLanguage} className="ml-auto" />
                </label>
              ))}
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
