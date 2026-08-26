'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ImagePlus, Plus, Send, Trash2, X } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Select';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useT, useLocale } from '@/i18n/client';
import { formatDateTime } from '@/lib/relativeTime';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { locales, type Locale } from '@/i18n/config';
import {
  ANNOUNCEMENT_IMAGE_ACCEPT,
  ANNOUNCEMENT_IMAGE_MAX_BYTES,
  validateAnnouncementImage,
} from '@/lib/announcementImage';
import {
  NEWSLETTER_MAX_TIPS,
  type NewsletterAudience,
  type NewsletterIssueContent,
  type NewsletterTip,
} from '@/lib/newsletter';

/**
 * The newsletter composer and the issue history (#1469).
 *
 * The composer is a FORM over the issue's fields, not a rich-text box — see the
 * header of `lib/newsletter.ts` for why. Everything here follows from that: one
 * tab per language, a tip list with an add button that stops at five, and a
 * preview rendered by the same server code that renders the real mail, so what
 * an admin approves is what the recipient gets.
 *
 * The image rules are imported from `announcementImage.ts` — the same objects
 * the announcement composer validates against, so a file rejected here is
 * rejected for the same reason and with the same limit.
 */

type Bodies = Partial<Record<Locale, NewsletterIssueContent>>;

interface TemplateRecord {
  key: string;
  topic: string;
  audience: NewsletterAudience;
  emoji: string;
  content: Record<Locale, NewsletterIssueContent>;
}

interface IssueRecord {
  id: string;
  templateKey: string | null;
  audience: NewsletterAudience;
  status: 'DRAFT' | 'SCHEDULED' | 'SENDING' | 'SENT' | 'CANCELED';
  subject: string;
  content: Bodies;
  languages: Locale[];
  scheduledAt: string | null;
  sentAt: string | null;
  recipientCount: number;
  sentCount: number;
  failedCount: number;
  skippedCount: number;
  createdAt: string;
  createdByName: string | null;
  createdBySystem: boolean;
  imageUrl: string | null;
}

const emptyIssue = (): NewsletterIssueContent => ({ subject: '', intro: '', tips: [{ emoji: '💡', title: '', body: '' }] });

/** A language counts as written once it could actually be sent. */
const isFilled = (c: NewsletterIssueContent | undefined): boolean =>
  !!c && !!c.subject.trim() && !!c.intro.trim() && c.tips.some((t) => t.title.trim());

export default function AdminNewslettersPage() {
  const t = useT();
  const locale = useLocale();
  const n = t.newsletter;

  const [templates, setTemplates] = useState<TemplateRecord[]>([]);
  const [bodies, setBodies] = useState<Bodies>({ [locale]: emptyIssue() } as Bodies);
  const [tab, setTab] = useState<Locale>(locale);
  const [audience, setAudience] = useState<NewsletterAudience>('MENTEE');
  const [templateKey, setTemplateKey] = useState<string | null>(null);
  const [image, setImage] = useState<{ file: File; url: string } | null>(null);
  const [scheduleAt, setScheduleAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [previewAs, setPreviewAs] = useState<'MENTEE' | 'MENTOR'>('MENTEE');
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);

  const [history, setHistory] = useState<IssueRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState(false);

  const [cadence, setCadence] = useState('off');
  const [cadenceAudience, setCadenceAudience] = useState<NewsletterAudience>('MENTEE');
  const [cadenceHour, setCadenceHour] = useState('9');
  const [cadenceSaved, setCadenceSaved] = useState(false);

  const current = bodies[tab] ?? emptyIssue();
  const filledLocales = useMemo(() => locales.filter((l) => isFilled(bodies[l])), [bodies]);

  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const res = await fetch('/api/admin/newsletters');
      const data = await res.json();
      setHistory(data.newsletters ?? []);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHistory();
    fetch('/api/admin/newsletters/templates')
      .then((r) => (r.ok ? r.json() : { templates: [] }))
      .then((d) => setTemplates(d.templates ?? []))
      .catch(() => setTemplates([]));
    fetch('/api/admin/settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.settings) return;
        setCadence(d.settings.newsletterSchedule ?? 'off');
        setCadenceAudience((d.settings.newsletterAudience as NewsletterAudience) ?? 'MENTEE');
        setCadenceHour(d.settings.newsletterSendHour ?? '9');
      })
      .catch(() => {});
  }, [fetchHistory]);

  // Object URLs have to be released when the picked file is replaced or the
  // page unmounts.
  useEffect(() => () => { if (image) URL.revokeObjectURL(image.url); }, [image]);

  const patch = (changes: Partial<NewsletterIssueContent>) =>
    setBodies((prev) => ({ ...prev, [tab]: { ...(prev[tab] ?? emptyIssue()), ...changes } }));

  const patchTip = (index: number, changes: Partial<NewsletterTip>) =>
    patch({ tips: (bodies[tab]?.tips ?? []).map((tip, i) => (i === index ? { ...tip, ...changes } : tip)) });

  const addTip = () => patch({ tips: [...(bodies[tab]?.tips ?? []), { emoji: '✅', title: '', body: '' }] });
  const removeTip = (index: number) => patch({ tips: (bodies[tab]?.tips ?? []).filter((_, i) => i !== index) });

  const applyTemplate = (template: TemplateRecord) => {
    // All three languages at once — the point of the library is that the issue
    // is already written for every reader.
    setBodies({ ...template.content });
    setAudience(template.audience);
    setTemplateKey(template.key);
    setPreviewHtml(null);
    setResult(null);
    setError(null);
  };

  const pickImage = async (file: File) => {
    const invalid = await validateAnnouncementImage(file);
    if (fileRef.current) fileRef.current.value = '';
    if (invalid) {
      setError({
        unsupported: n.imageUnsupported,
        tooLarge: n.imageTooLarge.replace('{mb}', String(ANNOUNCEMENT_IMAGE_MAX_BYTES / (1024 * 1024))),
        unreadable: n.imageUnreadable,
      }[invalid]);
      return;
    }
    setError(null);
    setImage({ file, url: URL.createObjectURL(file) });
  };

  const loadPreview = async () => {
    setError(null);
    const res = await fetch('/api/admin/newsletters/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: bodies, audience, locale: tab, asRole: previewAs }),
    });
    if (!res.ok) {
      setPreviewHtml(null);
      setError(n.previewEmpty);
      return;
    }
    const data = await res.json();
    setPreviewHtml(data.html);
  };

  /** Shared by all three verbs; returns the created issue's id. */
  const submit = async (action: 'draft' | 'schedule' | 'send'): Promise<string | null> => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const form = new FormData();
      form.set('content', JSON.stringify(bodies));
      form.set('audience', audience);
      form.set('action', action);
      if (templateKey) form.set('templateKey', templateKey);
      if (action === 'schedule') form.set('scheduledAt', new Date(scheduleAt).toISOString());
      if (image) form.set('image', image.file);

      const res = await fetch('/api/admin/newsletters', { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.details?.formErrors?.[0] ?? data?.error ?? n.errorGeneric);
        return null;
      }

      if (action === 'draft') setResult(n.savedDraft);
      else if (action === 'schedule') setResult(n.scheduled.replace('{when}', formatDateTime(scheduleAt, locale)));
      else if (data.dispatch) {
        setResult(
          n.sentResult
            .replace('{sent}', String(data.dispatch.sent))
            .replace('{recipients}', String(data.dispatch.recipients))
            .replace('{skipped}', String(data.dispatch.skipped))
            .replace('{failed}', String(data.dispatch.failed))
        );
      }
      await fetchHistory();
      return data.id ?? null;
    } catch {
      setError(n.errorGeneric);
      return null;
    } finally {
      setBusy(false);
    }
  };

  // A test needs a saved row (the image travels with it), so an unsaved
  // composer is saved as a draft first. That is also the honest behaviour: you
  // now have the draft you just mailed yourself.
  const sendTest = async () => {
    const id = await submit('draft');
    if (!id) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/newsletters/${id}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'test' }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setResult(n.sendTestDone.replace('{email}', data.to ?? ''));
      else setError(data?.error ?? n.errorGeneric);
    } finally {
      setBusy(false);
    }
  };

  const rowAction = async (id: string, body: object, method: 'PATCH' | 'POST' | 'DELETE', path = '') => {
    setRowBusy(true);
    try {
      const res = await fetch(`/api/admin/newsletters/${id}${path}`, {
        method,
        ...(method === 'DELETE' ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data?.error ?? n.errorGeneric);
      await fetchHistory();
    } finally {
      setRowBusy(false);
      setDeleteId(null);
    }
  };

  const saveCadence = async () => {
    setCadenceSaved(false);
    const res = await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        newsletterSchedule: cadence,
        newsletterAudience: cadenceAudience,
        newsletterSendHour: cadenceHour,
      }),
    });
    if (res.ok) setCadenceSaved(true);
    else setError(n.errorGeneric);
  };

  const audienceOptions = [
    { value: 'MENTEE', label: n.audienceMentee },
    { value: 'MENTOR', label: n.audienceMentor },
    { value: 'BOTH', label: n.audienceBoth },
  ];

  const statusLabel: Record<IssueRecord['status'], string> = {
    DRAFT: n.statusDraft,
    SCHEDULED: n.statusScheduled,
    SENDING: n.statusSending,
    SENT: n.statusSent,
    CANCELED: n.statusCanceled,
  };
  const statusVariant: Record<IssueRecord['status'], 'default' | 'info' | 'warning' | 'success' | 'danger'> = {
    DRAFT: 'default',
    SCHEDULED: 'info',
    SENDING: 'warning',
    SENT: 'success',
    CANCELED: 'danger',
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{n.title}</h1>
        <p className="text-gray-500 mt-1">{n.subtitle}</p>
      </div>

      {/* ── The curated library ─────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>{n.libraryTitle}</CardTitle>
          <p className="text-sm text-gray-500 mt-1">{n.libraryHint}</p>
        </CardHeader>
        <div className="p-4 pt-0">
          {templates.length === 0 ? (
            <p className="text-sm text-gray-500">{n.libraryEmpty}</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="newsletter-library">
              {templates.map((template) => (
                <div key={template.key} className="rounded-xl border border-gray-200 p-3 dark:border-gray-700">
                  <div className="flex items-start gap-2">
                    <span className="text-xl" aria-hidden>{template.emoji}</span>
                    <p className="flex-1 text-sm font-medium text-gray-900 dark:text-gray-100">
                      {(template.content[locale] ?? template.content.en).subject}
                    </p>
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <Badge variant={template.audience === 'MENTEE' ? 'info' : template.audience === 'MENTOR' ? 'purple' : 'success'}>
                      {template.audience === 'MENTEE' ? n.audienceMentee : template.audience === 'MENTOR' ? n.audienceMentor : n.audienceBoth}
                    </Badge>
                    <button
                      type="button"
                      onClick={() => applyTemplate(template)}
                      data-testid={`newsletter-template-${template.key}`}
                      className="text-sm font-medium text-blue-700 hover:underline dark:text-blue-300"
                    >
                      {n.libraryUse}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      {/* ── Composer ────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>{n.composeTitle}</CardTitle>
        </CardHeader>
        <div className="space-y-4 p-4 pt-0">
          <div className="grid gap-4 sm:grid-cols-2">
            <Select
              label={n.audience}
              hint={n.audienceHint}
              options={audienceOptions}
              value={audience}
              onChange={(e) => setAudience(e.target.value as NewsletterAudience)}
            />
            <div>
              <span className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">{n.preview}</span>
              <div className="flex gap-2">
                <Select
                  options={[
                    { value: 'MENTEE', label: n.previewAsMentee },
                    { value: 'MENTOR', label: n.previewAsMentor },
                  ]}
                  value={previewAs}
                  onChange={(e) => setPreviewAs(e.target.value as 'MENTEE' | 'MENTOR')}
                />
                <Button type="button" variant="secondary" onClick={loadPreview} data-testid="newsletter-preview-btn">
                  {n.previewRefresh}
                </Button>
              </div>
            </div>
          </div>

          {/* One tab per language, with a written/empty marker so a half-done
              issue is visible rather than silently sent in one language. */}
          <div className="flex flex-wrap gap-2" role="tablist">
            {locales.map((l) => (
              <button
                key={l}
                type="button"
                role="tab"
                aria-selected={tab === l}
                onClick={() => setTab(l)}
                data-testid={`newsletter-tab-${l}`}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                  tab === l
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200'
                }`}
              >
                {l.toUpperCase()} · {isFilled(bodies[l]) ? n.languageFilled : n.languageEmpty}
              </button>
            ))}
          </div>

          <Input
            label={n.subject}
            placeholder={n.subjectPlaceholder}
            maxLength={TEXT_LIMITS.newsletterSubject}
            value={current.subject}
            onChange={(e) => patch({ subject: e.target.value })}
            data-testid="newsletter-subject"
          />
          <Input
            label={n.preheader}
            placeholder={n.preheaderPlaceholder}
            maxLength={TEXT_LIMITS.newsletterPreheader}
            value={current.preheader ?? ''}
            onChange={(e) => patch({ preheader: e.target.value })}
          />
          <div>
            <span className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">{n.intro}</span>
            <Textarea
              rows={3}
              placeholder={n.introPlaceholder}
              maxLength={TEXT_LIMITS.newsletterIntro}
              showCounter
              value={current.intro}
              onChange={(e) => patch({ intro: e.target.value })}
              data-testid="newsletter-intro"
            />
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{n.tips}</span>
              <span className="text-xs text-gray-400">{n.tipsHint}</span>
            </div>
            <div className="space-y-3">
              {current.tips.map((tip, i) => (
                <div key={i} className="rounded-xl border border-gray-200 p-3 dark:border-gray-700">
                  <div className="flex gap-2">
                    <input
                      aria-label={n.tipEmojiLabel}
                      value={tip.emoji}
                      onChange={(e) => patchTip(i, { emoji: e.target.value })}
                      className="w-14 rounded-lg border border-gray-300 px-2 py-2 text-center text-lg dark:border-gray-600 dark:bg-gray-800"
                    />
                    <input
                      placeholder={n.tipTitlePlaceholder}
                      maxLength={TEXT_LIMITS.newsletterTipTitle}
                      value={tip.title}
                      onChange={(e) => patchTip(i, { title: e.target.value })}
                      data-testid={`newsletter-tip-title-${i}`}
                      className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800"
                    />
                    {current.tips.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeTip(i)}
                        aria-label={n.removeTip}
                        className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-gray-800"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                  <Textarea
                    rows={2}
                    placeholder={n.tipBodyPlaceholder}
                    maxLength={TEXT_LIMITS.newsletterTipBody}
                    value={tip.body}
                    onChange={(e) => patchTip(i, { body: e.target.value })}
                    className="mt-2"
                  />
                </div>
              ))}
            </div>
            {current.tips.length < NEWSLETTER_MAX_TIPS && (
              <Button type="button" variant="ghost" onClick={addTip} className="mt-2" data-testid="newsletter-add-tip">
                <Plus className="mr-1 h-4 w-4" />
                {n.addTip}
              </Button>
            )}
          </div>

          <div>
            <span className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">{n.action}</span>
            <Textarea
              rows={2}
              placeholder={n.actionPlaceholder}
              maxLength={TEXT_LIMITS.newsletterAction}
              value={current.action ?? ''}
              onChange={(e) => patch({ action: e.target.value })}
            />
          </div>

          {/* Only meaningful when mentors are in the audience — for a mentee-only
              issue the block would never be rendered to anybody. */}
          {audience !== 'MENTEE' && (
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{n.mentorNote}</span>
                <span className="text-xs text-gray-400">{n.mentorNoteHint}</span>
              </div>
              <Textarea
                rows={2}
                placeholder={n.mentorNotePlaceholder}
                maxLength={TEXT_LIMITS.newsletterMentorNote}
                value={current.mentorNote ?? ''}
                onChange={(e) => patch({ mentorNote: e.target.value })}
              />
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label={n.ctaLabel}
              placeholder={n.ctaLabelPlaceholder}
              maxLength={TEXT_LIMITS.newsletterCtaLabel}
              value={current.cta?.label ?? ''}
              onChange={(e) => patch({ cta: { label: e.target.value, url: current.cta?.url ?? '' } })}
            />
            <Input
              label={n.ctaUrl}
              placeholder={n.ctaUrlPlaceholder}
              maxLength={TEXT_LIMITS.newsletterCtaUrl}
              value={current.cta?.url ?? ''}
              onChange={(e) => patch({ cta: { label: current.cta?.label ?? '', url: e.target.value } })}
            />
          </div>

          <div>
            <span className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">{n.image}</span>
            <input
              ref={fileRef}
              type="file"
              accept={ANNOUNCEMENT_IMAGE_ACCEPT}
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) pickImage(f); }}
            />
            {image ? (
              <div className="flex items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={image.url} alt="" className="h-16 w-28 rounded-lg object-cover" />
                <Button type="button" variant="secondary" onClick={() => fileRef.current?.click()}>{n.imageReplace}</Button>
                <Button type="button" variant="ghost" onClick={() => { setImage(null); if (fileRef.current) fileRef.current.value = ''; }}>
                  {n.imageRemove}
                </Button>
              </div>
            ) : (
              <Button type="button" variant="secondary" onClick={() => fileRef.current?.click()}>
                <ImagePlus className="mr-1 h-4 w-4" />
                {n.imageAdd}
              </Button>
            )}
            <p className="mt-1 text-xs text-gray-400">
              {n.imageHint.replace('{mb}', String(ANNOUNCEMENT_IMAGE_MAX_BYTES / (1024 * 1024)))}
            </p>
          </div>

          <div className="flex flex-wrap items-end gap-3 border-t border-gray-200 pt-4 dark:border-gray-700">
            <Button type="button" variant="secondary" loading={busy} onClick={() => submit('draft')} data-testid="newsletter-save-draft">
              {n.saveDraft}
            </Button>
            <Button type="button" variant="secondary" loading={busy} onClick={sendTest} data-testid="newsletter-send-test">
              {n.sendTest}
            </Button>
            <div className="flex items-end gap-2">
              <Input
                label={n.scheduleFor}
                type="datetime-local"
                value={scheduleAt}
                onChange={(e) => setScheduleAt(e.target.value)}
                data-testid="newsletter-schedule-at"
              />
              <Button type="button" variant="secondary" disabled={!scheduleAt} loading={busy} onClick={() => submit('schedule')} data-testid="newsletter-schedule">
                {n.scheduleButton}
              </Button>
            </div>
            <Button type="button" loading={busy} disabled={filledLocales.length === 0} onClick={() => submit('send')} data-testid="newsletter-send-now">
              <Send className="mr-1 h-4 w-4" />
              {n.sendNow}
            </Button>
          </div>

          {result && <p className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800 dark:bg-green-950/40 dark:text-green-200" data-testid="newsletter-result">{result}</p>}
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200" data-testid="newsletter-error">{error}</p>}

          {previewHtml && (
            <iframe
              title={n.preview}
              srcDoc={previewHtml}
              // Fully sandboxed: no allow-* token at all, so the preview document
              // gets an opaque origin and script, forms and navigation are all
              // disabled (CodeQL flagged this srcdoc as an HTML sink, #1470).
              //
              // `srcDoc` renders composed HTML *inside the admin's own page*.
              // Every value in it is escaped by renderNewsletterHtml, but "our
              // own renderer escapes it" is one bug away from being false, and
              // the blast radius without this attribute is an admin session. An
              // e-mail body needs none of the capabilities being withheld — mail
              // clients do not run script either, so a preview that could is not
              // a faithful preview.
              sandbox=""
              data-testid="newsletter-preview"
              className="h-[520px] w-full rounded-xl border border-gray-200 bg-white dark:border-gray-700"
            />
          )}
        </div>
      </Card>

      {/* ── The automatic cadence ───────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>{n.cadenceTitle}</CardTitle>
          <p className="text-sm text-gray-500 mt-1">{n.cadenceHint}</p>
        </CardHeader>
        <div className="grid gap-4 p-4 pt-0 sm:grid-cols-4">
          <Select
            options={[
              { value: 'off', label: n.cadenceOff },
              { value: 'weekly', label: n.cadenceWeekly },
              { value: 'biweekly', label: n.cadenceBiweekly },
              { value: 'monthly', label: n.cadenceMonthly },
            ]}
            value={cadence}
            onChange={(e) => setCadence(e.target.value)}
            data-testid="newsletter-cadence"
          />
          <Select
            label={n.cadenceAudience}
            options={audienceOptions}
            value={cadenceAudience}
            onChange={(e) => setCadenceAudience(e.target.value as NewsletterAudience)}
          />
          <Input
            label={n.cadenceHour}
            type="number"
            min={0}
            max={23}
            value={cadenceHour}
            onChange={(e) => setCadenceHour(e.target.value)}
          />
          <div className="flex items-end gap-2">
            <Button type="button" variant="secondary" onClick={saveCadence} data-testid="newsletter-cadence-save">
              {n.cadenceSave}
            </Button>
            {cadenceSaved && <span className="pb-2 text-sm text-green-700 dark:text-green-300">{n.cadenceSaved}</span>}
          </div>
        </div>
      </Card>

      {/* ── The record ──────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>{n.historyTitle}</CardTitle>
        </CardHeader>
        <div className="p-4 pt-0">
          {historyLoading ? (
            <SkeletonRows rows={3} />
          ) : history.length === 0 ? (
            <p className="text-sm text-gray-500">{n.historyEmpty}</p>
          ) : (
            <ul className="divide-y divide-gray-200 dark:divide-gray-700" data-testid="newsletter-history">
              {history.map((issue) => (
                <li key={issue.id} className="py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={statusVariant[issue.status]}>{statusLabel[issue.status]}</Badge>
                        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{issue.subject}</span>
                        <span className="text-xs text-gray-400">{issue.languages.map((l) => l.toUpperCase()).join(' · ')}</span>
                      </div>
                      <p className="mt-1 text-xs text-gray-500">
                        {issue.audience === 'MENTEE' ? n.audienceMentee : issue.audience === 'MENTOR' ? n.audienceMentor : n.audienceBoth}
                        {issue.sentAt && ` · ${n.metaSentAt.replace('{when}', formatDateTime(issue.sentAt, locale))}`}
                        {!issue.sentAt && issue.scheduledAt && ` · ${n.metaScheduled.replace('{when}', formatDateTime(issue.scheduledAt, locale))}`}
                        {issue.createdBySystem && ` · ${n.queuedBySystem}`}
                      </p>
                      {issue.status === 'SENT' && (
                        <p className="mt-1 text-xs text-gray-500">
                          {n.metaRecipients.replace('{n}', String(issue.recipientCount))}
                          {' · '}{n.metaSent.replace('{n}', String(issue.sentCount))}
                          {issue.skippedCount > 0 && ` · ${n.metaSkipped.replace('{n}', String(issue.skippedCount))}`}
                          {issue.failedCount > 0 && ` · ${n.metaFailed.replace('{n}', String(issue.failedCount))}`}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {(issue.status === 'DRAFT' || issue.status === 'SCHEDULED') && (
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={rowBusy}
                          onClick={() => rowAction(issue.id, { mode: 'now' }, 'POST', '/send')}
                          data-testid={`newsletter-row-send-${issue.id}`}
                        >
                          {n.rowSend}
                        </Button>
                      )}
                      {issue.status === 'SCHEDULED' && (
                        <Button type="button" variant="ghost" disabled={rowBusy} onClick={() => rowAction(issue.id, { action: 'cancel' }, 'PATCH')}>
                          {n.rowCancel}
                        </Button>
                      )}
                      {(issue.status === 'DRAFT' || issue.status === 'CANCELED') && (
                        <button
                          type="button"
                          onClick={() => setDeleteId(issue.id)}
                          aria-label={n.rowDelete}
                          className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-gray-800"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <ConfirmDialog
        open={!!deleteId}
        title={n.rowDeleteTitle}
        message={n.rowDeleteConfirm}
        confirmLabel={n.rowDelete}
        cancelLabel={n.rowCancel}
        variant="danger"
        loading={rowBusy}
        onConfirm={() => deleteId && rowAction(deleteId, {}, 'DELETE')}
        onCancel={() => setDeleteId(null)}
      />
    </div>
  );
}
