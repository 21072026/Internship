'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useT, useLocale } from '@/i18n/client';
import { formatDateTime } from '@/lib/relativeTime';
import { EmptyState } from '@/components/ui/EmptyState';
import { Card } from '@/components/ui/Card';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { AlertTriangle, GitMerge, RefreshCw } from 'lucide-react';

// Admin review queue for suspected duplicate candidates (#841). The server
// scans every MENTEE pair in the org (src/lib/duplicateDetection.ts) and this
// page lets an admin compare the two records side by side and merge them
// (src/lib/mergeUsers.ts) behind the same double gate as erasure: typing the
// absorbed record's name + the acting admin's own password.

interface DuplicateRecord {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  whatsapp: string | null;
  university: string | null;
  createdAt: string;
  isActive: boolean;
}

interface DuplicatePair {
  a: DuplicateRecord;
  b: DuplicateRecord;
  signals: string[];
  score: number;
}

const pairKey = (p: DuplicatePair) => `${p.a.id}:${p.b.id}`;

function RecordSummary({ record }: { record: DuplicateRecord }) {
  const t = useT();
  const locale = useLocale();

  return (
    <div className="min-w-0 rounded-lg border border-gray-200 dark:border-gray-700 p-3">
      <div className="flex items-start justify-between gap-2">
        <Link
          href={`/admin/candidates/${record.id}`}
          className="min-w-0 break-words font-semibold text-gray-900 dark:text-gray-100 hover:text-blue-700 dark:hover:text-blue-300 hover:underline"
        >
          {record.fullName}
        </Link>
        {record.isActive ? (
          <Badge variant="success">{t.candidates.activeTab}</Badge>
        ) : (
          <Badge variant="danger">{t.candidates.inactive}</Badge>
        )}
      </div>
      <div className="mt-2 space-y-1 text-sm text-gray-600 dark:text-gray-300">
        <p className="truncate">{record.email}</p>
        {record.university && <p className="break-words">🎓 {record.university}</p>}
        {record.phone && <p>📞 {record.phone}</p>}
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t.duplicates.createdAt}: {formatDateTime(record.createdAt, locale)}
        </p>
      </div>
    </div>
  );
}

function DuplicatePairCard({ pair, onMerged }: {
  pair: DuplicatePair;
  onMerged: (absorbedId: string, movedCount: number) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [keepId, setKeepId] = useState(pair.a.id);
  const [confirmName, setConfirmName] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const signalLabels = t.duplicates.signals as Record<string, string>;
  const absorbed = keepId === pair.a.id ? pair.b : pair.a;

  const merge = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/admin/duplicates/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          primaryId: keepId,
          duplicateId: absorbed.id,
          confirmName,
          adminPassword,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || t.duplicates.failed);
        return;
      }
      const counts = (body.counts ?? {}) as Record<string, number>;
      const moved = Object.values(counts).reduce((sum, n) => sum + (typeof n === 'number' ? n : 0), 0);
      onMerged(absorbed.id, moved);
    } catch {
      setError(t.duplicates.failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card data-testid="duplicate-pair">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {pair.signals.map((s) => (
            <Badge key={s} variant={s === 'email' || s === 'phone' ? 'danger' : 'warning'}>
              {signalLabels[s] ?? s}
            </Badge>
          ))}
        </div>
        <span className="text-sm text-gray-500 dark:text-gray-400">
          {t.duplicates.score}: <span className="font-semibold text-gray-900 dark:text-gray-100">{pair.score}</span>
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <RecordSummary record={pair.a} />
        <RecordSummary record={pair.b} />
      </div>

      {!open ? (
        <div className="mt-4">
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            <GitMerge className="h-4 w-4" />
            {t.duplicates.mergeAction}
          </Button>
        </div>
      ) : (
        <div data-testid="merge-form" className="mt-4 space-y-3 border-t border-gray-100 dark:border-gray-800 pt-4">
          <h3 className="flex items-center gap-2 font-semibold text-red-700 dark:text-red-400">
            <AlertTriangle className="h-4 w-4" /> {t.duplicates.mergeTitle}
          </h3>

          {/* Which record survives — the other one is absorbed and deleted. */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {[pair.a, pair.b].map((record) => (
              <label
                key={record.id}
                className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm ${
                  keepId === record.id
                    ? 'border-blue-400 bg-blue-50 dark:bg-blue-950/40 dark:border-blue-700'
                    : 'border-gray-200 dark:border-gray-700'
                }`}
              >
                <input
                  type="radio"
                  name={`keep-${pairKey(pair)}`}
                  className="mt-0.5 flex-shrink-0"
                  checked={keepId === record.id}
                  onChange={() => {
                    setKeepId(record.id);
                    setConfirmName('');
                  }}
                />
                <span className="min-w-0">
                  <span className="block break-words font-medium text-gray-900 dark:text-gray-100">{record.fullName}</span>
                  <span className={`block text-xs ${keepId === record.id ? 'text-blue-700 dark:text-blue-300' : 'text-red-600 dark:text-red-400'}`}>
                    {keepId === record.id ? t.duplicates.keepLabel : t.duplicates.absorbLabel}
                  </span>
                </span>
              </label>
            ))}
          </div>

          <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 p-3 text-sm text-red-700 dark:text-red-300">
            {t.duplicates.mergeHint}
          </div>

          <div className="max-w-md space-y-3">
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                {t.duplicates.confirmNameLabel}
              </label>
              <input
                type="text"
                data-testid="merge-confirm-name"
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                {t.duplicates.adminPasswordLabel}
              </label>
              <input
                type="password"
                autoComplete="current-password"
                data-testid="merge-admin-password"
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm"
              />
            </div>
          </div>

          {error && <p className="text-xs text-red-600 dark:text-red-400" data-testid="merge-error">{error}</p>}

          <div className="flex items-center gap-2">
            <Button
              variant="danger"
              size="sm"
              loading={busy}
              disabled={confirmName.trim() !== absorbed.fullName || !adminPassword}
              onClick={merge}
            >
              {t.duplicates.confirmButton}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setOpen(false);
                setConfirmName('');
                setAdminPassword('');
                setError('');
              }}
            >
              {t.common.cancel}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

export default function DuplicatesPage() {
  const t = useT();
  const [pairs, setPairs] = useState<DuplicatePair[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const fetchPairs = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/duplicates');
      if (!res.ok) throw new Error('scan failed');
      const data = await res.json();
      setPairs(data.pairs || []);
    } catch {
      setError(t.duplicates.failed);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchPairs();
  }, [fetchPairs]);

  // Every pair involving the absorbed record is stale once it's gone.
  const handleMerged = (absorbedId: string, movedCount: number) => {
    setPairs((prev) => prev.filter((p) => p.a.id !== absorbedId && p.b.id !== absorbedId));
    setSuccess(t.duplicates.merged.replace('{count}', String(movedCount)));
  };

  return (
    <div>
      <div className="mb-8 flex flex-col items-start justify-between gap-4 sm:flex-row">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.duplicates.title}</h1>
          <p className="text-gray-500 mt-1">{t.duplicates.subtitle}</p>
        </div>
        <Button variant="outline" onClick={fetchPairs} disabled={loading} data-testid="duplicates-rescan">
          <RefreshCw className="h-4 w-4" />
          {t.duplicates.scan}
        </Button>
      </div>

      {success && (
        <div data-testid="merge-success" className="mb-4 p-3 bg-green-50 dark:bg-green-950/40 border border-green-200 dark:border-green-900 rounded-lg text-green-700 dark:text-green-300 text-sm">
          {success}
        </div>
      )}

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <Card><SkeletonRows rows={6} /></Card>
      ) : pairs.length === 0 ? (
        <Card>
          <EmptyState testId="duplicates" icon={GitMerge} title={t.duplicates.empty} />
        </Card>
      ) : (
        <div className="space-y-4">
          {pairs.map((pair) => (
            <DuplicatePairCard key={pairKey(pair)} pair={pair} onMerged={handleMerged} />
          ))}
        </div>
      )}
    </div>
  );
}
