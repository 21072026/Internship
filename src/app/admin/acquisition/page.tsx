'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Send } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useT } from '@/i18n/client';

// Postal campaigns (#2697): the list and the "new campaign" form. Design and
// the legal frame: docs/marketing-vertical/postal-campaigns.md.
//
// The form starts from the texts the server answers with (`defaults`, #2927):
// the organization's own saved letter, or the vertical's built-in one. The
// admin can save the letter in the form as the organization's default, or go
// back to the built-in one; a campaign already created keeps its own letter.

interface CampaignDefaults {
  letterBody: string;
  letterSource: 'org' | 'builtin';
  balancingNote: string;
}

interface CampaignRow {
  id: string;
  name: string;
  code: string;
  status: 'DRAFT' | 'SENT';
  sentAt: string | null;
  createdAt: string;
  recipients: number;
  inquiries: number;
  converted: number;
}

const textarea =
  'block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500';

export default function PostCampaignsPage() {
  const t = useT();
  const c = t.postCampaigns;
  const router = useRouter();
  const [rows, setRows] = useState<CampaignRow[] | null>(null);
  const [defaults, setDefaults] = useState<CampaignDefaults | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [dataSource, setDataSource] = useState('');
  const [balancingNote, setBalancingNote] = useState('');
  const [letterBody, setLetterBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [templateBusy, setTemplateBusy] = useState(false);
  const [templateNote, setTemplateNote] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/post-campaigns');
    const data = res.ok ? await res.json() : { campaigns: [] };
    setRows(data.campaigns ?? []);
    if (data.defaults) setDefaults(data.defaults as CampaignDefaults);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Fill the form from the defaults once they arrive — never over what the
  // admin has already typed.
  useEffect(() => {
    if (!defaults) return;
    setBalancingNote((v) => v || defaults.balancingNote);
    setLetterBody((v) => v || defaults.letterBody);
  }, [defaults]);

  // Save the letter in the form as the organization's default, or ('') go back
  // to the built-in letter (#2927).
  const saveTemplate = async (body: string) => {
    setTemplateBusy(true);
    setTemplateNote(null);
    try {
      const res = await fetch('/api/admin/post-campaigns/letter-template', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ letterBody: body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.defaults) {
        setTemplateNote({ ok: false, text: c.letterDefaultFailed });
        return;
      }
      const next = data.defaults as CampaignDefaults;
      setDefaults(next);
      if (body === '') setLetterBody(next.letterBody);
      setTemplateNote({ ok: true, text: body === '' ? c.letterDefaultReset : c.letterDefaultSaved });
    } catch {
      setTemplateNote({ ok: false, text: c.letterDefaultFailed });
    } finally {
      setTemplateBusy(false);
    }
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/admin/post-campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, dataSource, balancingNote, letterBody, ...(code.trim() ? { code: code.trim() } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        router.push(`/admin/acquisition/${data.id}`);
        return;
      }
      setError(data?.code === 'code_taken' ? c.codeTaken : data?.code === 'invalid' ? c.invalid : c.failed);
    } catch {
      setError(c.failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="post-campaigns-page">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-3xl">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{c.title}</h1>
          <p className="mt-1 text-gray-500">{c.subtitle}</p>
        </div>
        {!showForm && (
          <Button onClick={() => setShowForm(true)} data-testid="post-campaign-new">
            {c.newCampaign}
          </Button>
        )}
      </div>

      <p className="mb-6 rounded-lg bg-amber-50 p-3 text-sm text-amber-800" data-testid="post-campaigns-legal-note">
        {c.legalNote}
      </p>

      {showForm && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>{c.newCampaign}</CardTitle>
          </CardHeader>
          <form className="space-y-4" onSubmit={create} data-testid="post-campaign-form">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Input label={c.name} id="pc-name" value={name} onChange={(e) => setName(e.target.value)} required minLength={3} maxLength={120} data-testid="post-campaign-name" />
              <Input label={c.code} id="pc-code" value={code} onChange={(e) => setCode(e.target.value.toLowerCase())} maxLength={60} hint={c.codeHint} data-testid="post-campaign-code" />
            </div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              {c.dataSource}
              <textarea className={`${textarea} mt-1.5`} rows={2} required minLength={10} maxLength={2000} value={dataSource} onChange={(e) => setDataSource(e.target.value)} data-testid="post-campaign-data-source" />
              <span className="mt-1 block text-xs font-normal text-gray-500">{c.dataSourceHint}</span>
            </label>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              {c.balancingNote}
              <textarea className={`${textarea} mt-1.5`} rows={5} required minLength={20} maxLength={4000} value={balancingNote} onChange={(e) => setBalancingNote(e.target.value)} data-testid="post-campaign-balancing" />
              <span className="mt-1 block text-xs font-normal text-gray-500">{c.balancingHint}</span>
            </label>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              {c.letterBody}
              <textarea className={`${textarea} mt-1.5 font-mono`} rows={16} required minLength={20} maxLength={6000} value={letterBody} onChange={(e) => { setLetterBody(e.target.value); setTemplateNote(null); }} data-testid="post-campaign-letter" />
              <span className="mt-1 block text-xs font-normal text-gray-500">{c.letterHint}</span>
            </label>
            <div className="flex flex-wrap items-center gap-2" data-testid="post-campaign-letter-template">
              {defaults && letterBody === defaults.letterBody && (
                <span className="text-xs text-gray-500" data-testid="post-campaign-letter-source" data-source={defaults.letterSource}>
                  {defaults.letterSource === 'org' ? c.letterSourceOrg : c.letterSourceBuiltin}
                </span>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                loading={templateBusy}
                disabled={!defaults || letterBody.trim().length < 20 || (defaults.letterSource === 'org' && letterBody === defaults.letterBody)}
                onClick={() => void saveTemplate(letterBody)}
                data-testid="post-campaign-letter-save-default"
              >
                {c.letterSaveDefault}
              </Button>
              {defaults?.letterSource === 'org' && (
                <Button type="button" variant="ghost" size="sm" disabled={templateBusy} onClick={() => void saveTemplate('')} data-testid="post-campaign-letter-reset-default">
                  {c.letterResetDefault}
                </Button>
              )}
              {templateNote && (
                <span className={`text-xs ${templateNote.ok ? 'text-green-700' : 'text-red-700'}`} role="status" data-testid="post-campaign-letter-template-note">
                  {templateNote.text}
                </span>
              )}
            </div>
            {error && <p className="text-sm text-red-700" data-testid="post-campaign-error">{error}</p>}
            <div className="flex gap-2">
              <Button type="submit" loading={busy} data-testid="post-campaign-create">
                {c.create}
              </Button>
              <Button type="button" variant="outline" onClick={() => setShowForm(false)}>
                {t.common.cancel}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {rows === null ? (
        <SkeletonRows />
      ) : rows.length === 0 ? (
        !showForm && <EmptyState testId="post-campaigns-empty" title={c.title} body={c.empty} icon={Send} />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm" data-testid="post-campaigns-table">
            <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-3">{c.colName}</th>
                <th className="px-4 py-3">{c.colStatus}</th>
                <th className="px-4 py-3 text-right">{c.colRecipients}</th>
                <th className="px-4 py-3 text-right">{c.colInquiries}</th>
                <th className="px-4 py-3 text-right">{c.colConverted}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => (
                <tr key={r.id} data-testid={`post-campaign-row-${r.code}`}>
                  <td className="px-4 py-3">
                    <Link href={`/admin/acquisition/${r.id}`} className="font-medium text-blue-600 hover:underline">
                      {r.name}
                    </Link>
                    <span className="ml-2 font-mono text-xs text-gray-500">{r.code}</span>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={r.status === 'SENT' ? 'success' : 'default'}>{c.statuses[r.status]}</Badge>
                    {r.sentAt && <RelativeTime date={r.sentAt} className="ml-2 text-xs text-gray-500" />}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{r.recipients}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{r.inquiries}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{r.converted}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
