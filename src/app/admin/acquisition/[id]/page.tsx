'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Printer } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { fillTemplate } from '@/components/ui/fillTemplate';
import { useLocale, useT } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';
import { useResolvedStages, useStageLabel } from '@/lib/pipelineStagesClient';
import { SALES_CHANNELS } from '@/lib/salesChannels';

// One postal campaign (#2697): its texts while it is a draft, the account
// picker with each account's eligibility, the recipients, the print view and
// "mark as posted", and what the campaign brought in.

interface Campaign {
  id: string;
  name: string;
  code: string;
  status: 'DRAFT' | 'SENT';
  sentAt: string | null;
  dataSource: string;
  balancingNote: string;
  letterBody: string;
}
interface Recipient {
  id: string;
  companyId: string;
  companyName: string;
  addressBlock: string;
  sentAt: string | null;
}
interface Candidate {
  id: string;
  name: string;
  contactName: string | null;
  address: string | null;
  stage: string | null;
  lastSentAt: string | null;
  ineligible: string | null;
}

const textarea =
  'block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50';

export default function PostCampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useT();
  const c = t.postCampaigns;
  const locale = useLocale();
  const router = useRouter();
  const stages = useResolvedStages();
  const stageLabel = useStageLabel();

  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [results, setResults] = useState({ inquiries: 0, converted: 0 });
  const [shortLink, setShortLink] = useState('');
  const [missing, setMissing] = useState(false);
  const [draft, setDraft] = useState({ name: '', dataSource: '', balancingNote: '', letterBody: '' });
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [q, setQ] = useState('');
  const [stage, setStage] = useState('');
  const [channel, setChannel] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [refusedReasons, setRefusedReasons] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/post-campaigns/${id}`);
    if (!res.ok) {
      setMissing(true);
      return;
    }
    const data = await res.json();
    setCampaign(data.campaign);
    setRecipients(data.recipients);
    setResults(data.results);
    setShortLink(data.shortLink);
    setDraft({
      name: data.campaign.name,
      dataSource: data.campaign.dataSource,
      balancingNote: data.campaign.balancingNote,
      letterBody: data.campaign.letterBody,
    });
  }, [id]);

  const loadCandidates = useCallback(async () => {
    const qs = new URLSearchParams();
    if (q.trim()) qs.set('q', q.trim());
    if (stage) qs.set('stage', stage);
    if (channel) qs.set('channel', channel);
    const res = await fetch(`/api/admin/post-campaigns/${id}/candidates?${qs}`);
    setCandidates(res.ok ? (await res.json()).candidates : []);
  }, [id, q, stage, channel]);

  useEffect(() => {
    void load();
  }, [load]);

  const isDraft = campaign?.status === 'DRAFT';
  useEffect(() => {
    if (!isDraft) return;
    const timer = setTimeout(() => void loadCandidates(), 250);
    return () => clearTimeout(timer);
  }, [isDraft, loadCandidates]);

  const eligibleIds = useMemo(() => (candidates ?? []).filter((x) => !x.ineligible).map((x) => x.id), [candidates]);

  const call = async (url: string, init: RequestInit) => {
    setBusy(true);
    setNotice('');
    try {
      const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, data };
    } catch {
      return { ok: false, data: {} as Record<string, unknown> };
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const { ok, data } = await call(`/api/admin/post-campaigns/${id}`, { method: 'PATCH', body: JSON.stringify(draft) });
    setNotice(ok ? c.saved : data?.code === 'invalid' ? c.invalid : c.failed);
    if (ok) void load();
  };

  const remove = async () => {
    if (!window.confirm(c.deleteConfirm)) return;
    const { ok } = await call(`/api/admin/post-campaigns/${id}`, { method: 'DELETE' });
    if (ok) router.push('/admin/acquisition');
    else setNotice(c.failed);
  };

  const add = async () => {
    const { ok, data } = await call(`/api/admin/post-campaigns/${id}/recipients`, {
      method: 'POST',
      body: JSON.stringify({ companyIds: [...selected] }),
    });
    if (!ok) {
      setNotice(c.failed);
      return;
    }
    const refused = (data.refused ?? []) as { companyId: string; reason: string }[];
    setRefusedReasons(Object.fromEntries(refused.map((r) => [r.companyId, r.reason])));
    setNotice([c.added.replace('{n}', String(data.added)), refused.length ? c.refused.replace('{n}', String(refused.length)) : ''].filter(Boolean).join(' '));
    setSelected(new Set());
    await Promise.all([load(), loadCandidates()]);
  };

  const takeOff = async (companyId: string) => {
    const { ok } = await call(`/api/admin/post-campaigns/${id}/recipients?companyId=${encodeURIComponent(companyId)}`, { method: 'DELETE' });
    if (ok) await Promise.all([load(), loadCandidates()]);
  };

  const markSent = async () => {
    if (!window.confirm(c.markSentConfirm)) return;
    const { ok, data } = await call(`/api/admin/post-campaigns/${id}/send`, { method: 'POST' });
    if (!ok) {
      setNotice(c.failed);
      return;
    }
    setNotice(c.sentResult.replace('{sent}', String(data.sent)).replace('{skipped}', String(data.skipped)));
    await load();
  };

  if (missing) {
    return (
      <div>
        <Link href="/admin/acquisition" className="text-sm text-blue-600 hover:underline">{c.back}</Link>
        <p className="mt-4 text-gray-500">{c.failed}</p>
      </div>
    );
  }
  if (!campaign) return <SkeletonRows />;

  const date = (value: string) => formatDate(new Date(value), locale);

  return (
    <div data-testid="post-campaign-detail" data-status={campaign.status}>
      <Link href="/admin/acquisition" className="mb-4 inline-flex items-center gap-1 text-sm text-blue-600 hover:underline">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> {c.back}
      </Link>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{campaign.name}</h1>
          <p className="mt-1 text-sm text-gray-500">
            <Badge variant={isDraft ? 'default' : 'success'} data-testid="post-campaign-status">{c.statuses[campaign.status]}</Badge>
            <span className="ml-3">{c.shortLink}: </span>
            <span className="font-mono" data-testid="post-campaign-short-link">{shortLink}</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {recipients.length > 0 && (
            <a
              href={`/print/post-campaign/${campaign.id}`}
              target="_blank"
              rel="noopener"
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              data-testid="post-campaign-print"
            >
              <Printer className="h-4 w-4" aria-hidden="true" /> {c.print}
            </a>
          )}
          {isDraft && recipients.length > 0 && (
            <Button onClick={markSent} loading={busy} data-testid="post-campaign-mark-sent">
              {c.markSent}
            </Button>
          )}
        </div>
      </div>

      {notice && (
        <p className="mb-4 rounded-lg bg-blue-50 p-3 text-sm text-blue-800" role="status" data-testid="post-campaign-notice">
          {notice}
        </p>
      )}
      {/* Stays a date: "Sent on {date}" / "{date} tarihinde" is the record's
          own wording, and it does not read with "3 days ago" in the slot. */}
      {!isDraft && campaign.sentAt && (
        <p className="mb-4 rounded-lg bg-gray-50 p-3 text-sm text-gray-700" data-testid="post-campaign-locked">
          {c.lockedNote.replace('{date}', date(campaign.sentAt))}
        </p>
      )}

      <div className="mb-6 grid grid-cols-1 gap-6 sm:grid-cols-3">
        <Card>
          <p className="text-sm text-gray-500">{c.colRecipients}</p>
          <p className="text-2xl font-bold tabular-nums">{recipients.length}</p>
        </Card>
        <Card>
          <p className="text-sm text-gray-500">{c.colInquiries}</p>
          <p className="text-2xl font-bold tabular-nums" data-testid="post-campaign-inquiries">{results.inquiries}</p>
        </Card>
        <Card>
          <p className="text-sm text-gray-500">{c.colConverted}</p>
          <p className="text-2xl font-bold tabular-nums" data-testid="post-campaign-converted">{results.converted}</p>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{c.settings}</CardTitle>
          </CardHeader>
          <div className="space-y-4">
            <Input label={c.name} id="pc-name" value={draft.name} disabled={!isDraft} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              {c.dataSource}
              <textarea className={`${textarea} mt-1.5`} rows={2} disabled={!isDraft} value={draft.dataSource} onChange={(e) => setDraft({ ...draft, dataSource: e.target.value })} />
              <span className="mt-1 block text-xs font-normal text-gray-500">{c.dataSourceHint}</span>
            </label>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              {c.balancingNote}
              <textarea className={`${textarea} mt-1.5`} rows={4} disabled={!isDraft} value={draft.balancingNote} onChange={(e) => setDraft({ ...draft, balancingNote: e.target.value })} />
            </label>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              {c.letterBody}
              <textarea className={`${textarea} mt-1.5 font-mono`} rows={14} disabled={!isDraft} value={draft.letterBody} onChange={(e) => setDraft({ ...draft, letterBody: e.target.value })} />
              <span className="mt-1 block text-xs font-normal text-gray-500">{c.letterHint}</span>
            </label>
            {isDraft && (
              <div className="flex flex-wrap gap-2">
                <Button onClick={save} loading={busy} data-testid="post-campaign-save">{c.save}</Button>
                <Button variant="outline" onClick={remove} disabled={busy} data-testid="post-campaign-delete">{c.delete}</Button>
              </div>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{c.recipientsTitle.replace('{n}', String(recipients.length))}</CardTitle>
          </CardHeader>
          {recipients.length === 0 ? (
            <p className="text-sm text-gray-500">{c.noRecipients}</p>
          ) : (
            <ul className="divide-y divide-gray-100" data-testid="post-campaign-recipients">
              {recipients.map((r) => (
                <li key={r.id} className="flex items-start justify-between gap-3 py-2" data-testid={`post-campaign-recipient-${r.companyId}`}>
                  <div className="min-w-0">
                    <Link href={`/admin/companies/${r.companyId}`} className="text-sm font-medium text-blue-600 hover:underline">{r.companyName}</Link>
                    <p className="whitespace-pre-line text-xs text-gray-500">{r.addressBlock}</p>
                    {r.sentAt && <p className="text-xs text-green-700">{c.statuses.SENT} <RelativeTime date={r.sentAt} /></p>}
                  </div>
                  {isDraft && (
                    <Button size="sm" variant="ghost" onClick={() => void takeOff(r.companyId)} disabled={busy}>{c.remove}</Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {isDraft && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>{c.candidatesTitle}</CardTitle>
          </CardHeader>
          <div className="mb-4 flex flex-wrap items-end gap-3">
            <div className="w-64">
              <Input label={c.search} id="pc-search" type="text" value={q} onChange={(e) => setQ(e.target.value)} data-testid="post-campaign-search" />
            </div>
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
              {c.stage}
              <select className="mt-1.5 block rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900" value={stage} onChange={(e) => setStage(e.target.value)} data-testid="post-campaign-stage">
                <option value="">{c.allStages}</option>
                {stages.map((s) => (
                  <option key={s.key} value={s.key}>{stageLabel(s.key)}</option>
                ))}
              </select>
            </label>
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
              {c.channel}
              <select className="mt-1.5 block rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900" value={channel} onChange={(e) => setChannel(e.target.value)} data-testid="post-campaign-channel">
                <option value="">{c.allChannels}</option>
                {SALES_CHANNELS.filter((x) => x.kind !== 'CARRIER').map((x) => (
                  <option key={x.key} value={x.key}>{x.label}</option>
                ))}
              </select>
            </label>
            <Button variant="outline" size="sm" onClick={() => setSelected(new Set(eligibleIds))} disabled={eligibleIds.length === 0}>
              {c.selectEligible}
            </Button>
            <Button onClick={add} loading={busy} disabled={selected.size === 0} data-testid="post-campaign-add">
              {c.addSelected.replace('{n}', String(selected.size))}
            </Button>
          </div>
          {candidates === null ? (
            <SkeletonRows rows={4} />
          ) : candidates.length === 0 ? (
            <p className="text-sm text-gray-500">{c.noCandidates}</p>
          ) : (
            <ul className="divide-y divide-gray-100" data-testid="post-campaign-candidates">
              {candidates.map((x) => {
                const reason = refusedReasons[x.id] ?? x.ineligible;
                return (
                  <li key={x.id} className="flex items-start gap-3 py-2" data-testid={`post-campaign-candidate-${x.id}`} data-ineligible={x.ineligible ?? ''}>
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4"
                      aria-label={x.name}
                      disabled={!!x.ineligible}
                      checked={selected.has(x.id)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(x.id);
                        else next.delete(x.id);
                        setSelected(next);
                      }}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{x.name}</p>
                      <p className="truncate text-xs text-gray-500">{[x.contactName, x.address?.replace(/\s*\n\s*/g, ', ')].filter(Boolean).join(' · ')}</p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {x.stage && <Badge variant="info">{stageLabel(x.stage)}</Badge>}
                      {reason && (
                        <Badge variant={reason === 'objected' || reason === 'suppressed' ? 'danger' : 'warning'} data-testid={`post-campaign-reason-${x.id}`}>
                          {c.reasons[reason as keyof typeof c.reasons] ?? reason}
                        </Badge>
                      )}
                      {x.lastSentAt && <span className="text-xs text-gray-500">{fillTemplate(c.lastLetter, { date: <RelativeTime date={x.lastSentAt} /> })}</span>}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{c.resultsTitle}</CardTitle>
        </CardHeader>
        <p className="text-sm text-gray-500">{c.resultsHint}</p>
        <Link href="/admin/company-inquiries" className="mt-2 inline-block text-sm text-blue-600 hover:underline">
          {t.nav.companyInquiries}
        </Link>
      </Card>
    </div>
  );
}
