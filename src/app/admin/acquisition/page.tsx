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
import { useLocale, useT } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';
import { useVertical } from '@/lib/verticalClient';
import { defaultBalancingNote, defaultLetterBody } from '@/lib/postCampaignTemplates';

// Postal campaigns (#2697): the list and the "new campaign" form. Design and
// the legal frame: docs/marketing-vertical/postal-campaigns.md.

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
  const locale = useLocale();
  const vertical = useVertical();
  const router = useRouter();
  const [rows, setRows] = useState<CampaignRow[] | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [dataSource, setDataSource] = useState('');
  const [balancingNote, setBalancingNote] = useState(() => defaultBalancingNote(vertical));
  const [letterBody, setLetterBody] = useState(() => defaultLetterBody(vertical));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/post-campaigns');
    const data = res.ok ? await res.json() : { campaigns: [] };
    setRows(data.campaigns ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
              <textarea className={`${textarea} mt-1.5 font-mono`} rows={16} required minLength={20} maxLength={6000} value={letterBody} onChange={(e) => setLetterBody(e.target.value)} data-testid="post-campaign-letter" />
              <span className="mt-1 block text-xs font-normal text-gray-500">{c.letterHint}</span>
            </label>
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
                    {r.sentAt && <span className="ml-2 text-xs text-gray-500">{formatDate(new Date(r.sentAt), locale)}</span>}
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
