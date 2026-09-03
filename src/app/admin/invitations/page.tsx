'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, RoleBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Download, Mail, RefreshCw, Trash2, Ban } from 'lucide-react';
import { useLocale, useT } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';
import {
  INVITATION_STATUSES,
  emptyInvitationCounts,
  type InvitationStatus,
} from '@/lib/invitationStatus';

// The invitation status board (#2071).
//
// "Who has actually joined?" answered on one screen: every invitation with its
// derived status, per-status counts, filters, and the bulk actions an admin
// reaches for afterwards (re-invite the stale ones, revoke the mistakes).
//
// The status itself is NEVER computed here — the server derives it through
// src/lib/invitationStatus.ts and sends it down, so the badge, the filter, the
// counts and the CSV export can never disagree about what "expired" means.

interface BoardInvitation {
  id: string;
  email: string | null;
  label: string | null;
  role: string;
  status: InvitationStatus;
  createdAt: string;
  expiresAt: string;
  openedAt: string | null;
  registeredAt: string | null;
  verifiedAt: string | null;
  revokedAt: string | null;
  invitedByName: string | null;
  canResend: boolean;
  canRevoke: boolean;
  canDelete: boolean;
}

type BulkAction = 'resend' | 'revoke' | 'delete';

interface RowResult {
  id: string;
  ok: boolean;
  outcome: string;
  email: string | null;
  label: string | null;
}

const STATUS_VARIANT: Record<InvitationStatus, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
  sent: 'default',
  opened: 'info',
  registered: 'success',
  verified: 'success',
  expired: 'warning',
  revoked: 'danger',
};

const ROLES = ['ADMIN', 'MENTOR', 'MENTEE'] as const;

export default function AdminInvitationsPage() {
  const t = useT();
  const locale = useLocale();
  const v = t.invitations;

  const [q, setQ] = useState('');
  // Debounced copy of `q`: the board refetches as the admin types, and one
  // request per keystroke would hammer a query that scans the whole tenant.
  const [debouncedQ, setDebouncedQ] = useState('');
  const [status, setStatus] = useState<InvitationStatus | ''>('');
  const [role, setRole] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const [rows, setRows] = useState<BoardInvitation[]>([]);
  const [counts, setCounts] = useState<Record<InvitationStatus, number>>(emptyInvitationCounts());
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState<BulkAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ action: BulkAction; changed: number; skipped: number; results: RowResult[] } | null>(null);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(id);
  }, [q]);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (debouncedQ) p.set('q', debouncedQ);
    if (status) p.set('status', status);
    if (role) p.set('role', role);
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    return p;
  }, [debouncedQ, status, role, from, to]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/invitations?${params.toString()}`);
      if (!res.ok) throw new Error('failed');
      const data = await res.json();
      setRows((data.invitations ?? []) as BoardInvitation[]);
      setCounts({ ...emptyInvitationCounts(), ...(data.counts ?? {}) });
      setTruncated(Boolean(data.truncated));
    } catch {
      setRows([]);
      setError(v.failed);
    } finally {
      setLoading(false);
    }
  }, [params, v.failed]);

  useEffect(() => {
    load();
  }, [load]);

  // Selection only ever names rows currently on screen: narrowing the filter
  // must not leave an invisible row selected that a bulk action would then hit.
  const visibleIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const selectedVisible = useMemo(
    () => selected.filter((id) => visibleIds.includes(id)),
    [selected, visibleIds],
  );
  useEffect(() => {
    setSelected((prev) => prev.filter((id) => visibleIds.includes(id)));
  }, [visibleIds]);

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const allSelected = rows.length > 0 && selectedVisible.length === rows.length;
  const toggleAll = () => setSelected(allSelected ? [] : visibleIds);

  const clearFilters = () => {
    setQ('');
    setStatus('');
    setRole('');
    setFrom('');
    setTo('');
  };

  const runAction = async (action: BulkAction) => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/admin/invitations/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedVisible, action }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error('failed');
      setResult({ action, changed: data.changed ?? 0, skipped: data.skipped ?? 0, results: data.results ?? [] });
      setSelected([]);
      await load();
    } catch {
      setError(v.failed);
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const exportCsv = async () => {
    const res = await fetch(`/api/admin/invitations?${params.toString()}&format=csv`);
    if (!res.ok) {
      setError(v.failed);
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `invitations-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const fill = (template: string, values: Record<string, string | number>) =>
    Object.entries(values).reduce((acc, [k, val]) => acc.split(`{${k}}`).join(String(val)), template);

  const outcomeLabel = (outcome: string) =>
    (v.outcome as Record<string, string>)[outcome] ?? outcome;

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{v.title}</h1>
          <p className="text-gray-500 mt-1 max-w-3xl">{v.subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={exportCsv} data-testid="invitations-export">
            <Download className="h-4 w-4" />
            {v.exportCsv}
          </Button>
          <Link href="/admin/invite">
            <Button size="sm" data-testid="invitations-send">
              <Mail className="h-4 w-4" />
              {v.sendInvitation}
            </Button>
          </Link>
        </div>
      </div>

      {/* Per-status counts. Each one doubles as the status filter — the number
          an admin is looking at is the thing they want to click. */}
      <div className="mb-4 flex flex-wrap gap-2" data-testid="invitations-counts">
        {INVITATION_STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatus((prev) => (prev === s ? '' : s))}
            aria-pressed={status === s}
            data-testid={`invitations-count-${s}`}
            className={`rounded-xl border px-3 py-2 text-left transition-colors ${
              status === s
                ? 'border-blue-400 bg-blue-50 dark:bg-blue-950/40'
                : 'border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800'
            }`}
          >
            <span className="block text-lg font-semibold text-gray-900 dark:text-gray-100">{counts[s]}</span>
            <span className="block text-xs text-gray-500">{v.status[s]}</span>
          </button>
        ))}
      </div>

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div>
          <label htmlFor="invitations-search" className="block text-xs font-medium text-gray-500 mb-1">
            {v.searchLabel}
          </label>
          {/* data-testid, not input[type=search]: AdminNav renders its own
              search box on every admin page and an unscoped locator hits that. */}
          <input
            id="invitations-search"
            data-testid="invitations-search"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={v.searchPlaceholder}
            className="block min-h-11 w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
          />
        </div>
        <div>
          <label htmlFor="invitations-status" className="block text-xs font-medium text-gray-500 mb-1">
            {v.statusLabel}
          </label>
          <select
            id="invitations-status"
            data-testid="invitations-status"
            value={status}
            onChange={(e) => setStatus(e.target.value as InvitationStatus | '')}
            className="block min-h-11 w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
          >
            <option value="">{v.all}</option>
            {INVITATION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {v.status[s]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="invitations-role" className="block text-xs font-medium text-gray-500 mb-1">
            {v.roleLabel}
          </label>
          <select
            id="invitations-role"
            data-testid="invitations-role"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="block min-h-11 w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
          >
            <option value="">{v.all}</option>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {(t.usersAdmin as unknown as Record<string, string>)[r.toLowerCase()] ?? r}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="invitations-from" className="block text-xs font-medium text-gray-500 mb-1">
            {v.fromLabel}
          </label>
          <input
            id="invitations-from"
            data-testid="invitations-from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="block min-h-11 w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
          />
        </div>
        <div>
          <label htmlFor="invitations-to" className="block text-xs font-medium text-gray-500 mb-1">
            {v.toLabel}
          </label>
          <div className="flex items-end gap-2">
            <input
              id="invitations-to"
              data-testid="invitations-to"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="block min-h-11 w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
            />
            <Button variant="ghost" size="sm" onClick={clearFilters} data-testid="invitations-clear">
              {v.clearFilters}
            </Button>
          </div>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="invitations-actions">
        <span className="text-sm text-gray-500">
          {fill(v.selectedCount, { count: selectedVisible.length })}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={selectedVisible.length === 0 || busy}
          onClick={() => setPending('resend')}
          data-testid="invitations-resend"
        >
          <RefreshCw className="h-4 w-4" />
          {v.actions.resend}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={selectedVisible.length === 0 || busy}
          onClick={() => setPending('revoke')}
          data-testid="invitations-revoke"
        >
          <Ban className="h-4 w-4" />
          {v.actions.revoke}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={selectedVisible.length === 0 || busy}
          onClick={() => setPending('delete')}
          data-testid="invitations-delete"
        >
          <Trash2 className="h-4 w-4" />
          {v.actions.delete}
        </Button>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700" data-testid="invitations-error">
          {error}
        </div>
      )}

      {result && (
        <div
          className="mb-4 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4"
          data-testid="invitations-result"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{v.resultTitle}</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {fill(v.resultSummary, {
                  changed: result.changed,
                  total: result.changed + result.skipped,
                  skipped: result.skipped,
                })}
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setResult(null)}>
              {v.dismiss}
            </Button>
          </div>
          <ul className="mt-3 space-y-1 max-h-60 overflow-y-auto">
            {result.results.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 text-xs">
                <span className="truncate text-gray-700 dark:text-gray-300">
                  {r.email ?? r.label ?? v.linkInvitation}
                </span>
                <span className={r.ok ? 'text-green-600 flex-shrink-0' : 'text-gray-400 flex-shrink-0'}>
                  {outcomeLabel(r.outcome)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {truncated && (
        <p className="mb-3 text-xs text-gray-500">{fill(v.truncated, { count: rows.length })}</p>
      )}

      {loading ? (
        <p className="py-10 text-center text-sm text-gray-400">{v.loading}</p>
      ) : rows.length === 0 ? (
        <div
          data-testid="invitations-empty"
          className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-10 text-center text-gray-400"
        >
          {v.empty}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
          <table className="w-full text-sm" data-testid="invitations-table">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-800 text-left text-gray-500">
                <th className="px-4 py-3 w-10">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    aria-label={v.selectAll}
                    data-testid="invitations-select-all"
                  />
                </th>
                <th className="px-4 py-3 font-medium">{v.columns.recipient}</th>
                <th className="px-4 py-3 font-medium">{v.columns.role}</th>
                <th className="px-4 py-3 font-medium">{v.columns.status}</th>
                <th className="px-4 py-3 font-medium">{v.columns.sent}</th>
                <th className="px-4 py-3 font-medium">{v.columns.opened}</th>
                <th className="px-4 py-3 font-medium">{v.columns.registered}</th>
                <th className="px-4 py-3 font-medium">{v.columns.verified}</th>
                <th className="px-4 py-3 font-medium">{v.columns.invitedBy}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  data-testid={`invitation-row-${row.id}`}
                  className="border-b border-gray-100 dark:border-gray-800/60 last:border-0"
                >
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selected.includes(row.id)}
                      onChange={() => toggle(row.id)}
                      aria-label={row.email ?? row.label ?? v.linkInvitation}
                      data-testid={`invitation-select-${row.id}`}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900 dark:text-gray-100">
                      {row.email ?? v.linkInvitation}
                    </div>
                    {row.label && <div className="text-xs text-gray-400">{row.label}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <RoleBadge role={row.role} />
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={STATUS_VARIANT[row.status]} data-testid={`invitation-status-${row.id}`}>
                      {v.status[row.status]}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-gray-500">{formatDate(row.createdAt, locale)}</td>
                  <td className="px-4 py-3 text-gray-500">{row.openedAt ? formatDate(row.openedAt, locale) : '—'}</td>
                  <td className="px-4 py-3 text-gray-500">
                    {row.registeredAt ? formatDate(row.registeredAt, locale) : '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {row.verifiedAt ? formatDate(row.verifiedAt, locale) : '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-500">{row.invitedByName ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={pending !== null}
        message={pending ? fill(v.confirm[pending], { count: selectedVisible.length }) : ''}
        confirmLabel={pending ? v.actions[pending] : ''}
        cancelLabel={t.common.cancel}
        variant={pending === 'resend' ? 'default' : 'danger'}
        loading={busy}
        onConfirm={() => pending && runAction(pending)}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}
