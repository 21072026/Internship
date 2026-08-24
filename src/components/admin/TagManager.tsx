'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, GitMerge, Loader2, Pencil, Trash2, X } from 'lucide-react';
import { useT } from '@/i18n/client';
import { MAX_TAGS_PER_ORG, isValidTagName } from '@/lib/tags';

interface Row {
  id: string;
  name: string;
  color: string | null;
  usageCount: number;
}

/**
 * The org's tag vocabulary, as something that can be repaired (#845).
 *
 * The caps stop it growing without limit; this screen is what cleans up the
 * drift that already happened. Renaming keeps the tag's id, so nobody loses the
 * label and no saved view silently empties. Merging is the one that matters
 * most — "Backend", "back-end" and "Back End" are one idea written three ways,
 * and without it the only ways out are to live with the split or to delete two
 * of them and lose who carried them.
 */
export function TagManager() {
  const t = useT();
  const m = t.tagAdmin;
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const [editing, setEditing] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftColor, setDraftColor] = useState('');
  const [merging, setMerging] = useState<string | null>(null);
  const [mergeInto, setMergeInto] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch('/api/tags')
      .then((r) => (r.ok ? r.json() : { tags: [] }))
      .then((d) => setRows(d.tags ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const call = async (url: string, init: RequestInit, id: string) => {
    setBusyId(id);
    setError('');
    try {
      const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.code === 'duplicate' ? m.errorDuplicate : (body?.error ?? m.errorGeneric));
        return false;
      }
      load();
      return true;
    } finally {
      setBusyId(null);
    }
  };

  const startEdit = (row: Row) => {
    setEditing(row.id);
    setMerging(null);
    setConfirmDelete(null);
    setDraftName(row.name);
    setDraftColor(row.color ?? '');
  };

  const saveEdit = async (row: Row) => {
    if (!isValidTagName(draftName)) return setError(m.errorName);
    const ok = await call(`/api/tags/${row.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: draftName, color: draftColor || null }),
    }, row.id);
    if (ok) setEditing(null);
  };

  const doMerge = async (row: Row) => {
    if (!mergeInto) return;
    const ok = await call(`/api/tags/${row.id}/merge`, { method: 'POST', body: JSON.stringify({ into: mergeInto }) }, row.id);
    if (ok) { setMerging(null); setMergeInto(''); }
  };

  const doDelete = async (row: Row) => {
    const ok = await call(`/api/tags/${row.id}`, { method: 'DELETE' }, row.id);
    if (ok) setConfirmDelete(null);
  };

  if (loading) return <p className="text-sm text-gray-400">{m.loading}</p>;

  if (rows.length === 0) {
    return (
      <div data-testid="tag-admin-empty" className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-10 text-center">
        <p className="text-gray-500">{m.none}</p>
        <p className="mt-1 text-sm text-gray-400">{m.noneHint}</p>
      </div>
    );
  }

  return (
    <div>
      <p className="mb-3 text-xs text-gray-400">{m.count.replace('{n}', String(rows.length)).replace('{max}', String(MAX_TAGS_PER_ORG))}</p>
      {error && (
        <p data-testid="tag-admin-error" className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

      <div className="overflow-x-auto rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
        <table className="w-full text-sm" data-testid="tag-admin-table">
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-800 text-left text-gray-500">
              <th className="px-4 py-3 font-medium">{m.colName}</th>
              <th className="px-4 py-3 font-medium">{m.colUsage}</th>
              <th className="px-4 py-3 font-medium text-right"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} data-testid={`tag-row-${row.id}`} className="border-b border-gray-100 dark:border-gray-800/60 last:border-0 align-top">
                <td className="px-4 py-3">
                  {editing === row.id ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        value={draftName}
                        onChange={(e) => setDraftName(e.target.value)}
                        data-testid="tag-edit-name"
                        className="rounded-lg border border-gray-300 dark:border-gray-700 px-2 py-1 text-sm dark:bg-gray-800"
                      />
                      <input
                        type="color"
                        value={draftColor || '#64748b'}
                        onChange={(e) => setDraftColor(e.target.value)}
                        data-testid="tag-edit-color"
                        className="h-8 w-10 cursor-pointer rounded border border-gray-300 dark:border-gray-700"
                        aria-label={m.colColor}
                      />
                    </div>
                  ) : (
                    <span className="inline-flex items-center gap-2">
                      <span
                        className="inline-block h-3 w-3 rounded-full border border-black/10"
                        style={{ backgroundColor: row.color ?? '#cbd5e1' }}
                        aria-hidden="true"
                      />
                      <span className="font-medium text-gray-900 dark:text-gray-100">{row.name}</span>
                    </span>
                  )}

                  {merging === row.id && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <select
                        value={mergeInto}
                        onChange={(e) => setMergeInto(e.target.value)}
                        data-testid="tag-merge-target"
                        className="rounded-lg border border-gray-300 dark:border-gray-700 px-2 py-1 text-sm dark:bg-gray-800"
                      >
                        <option value="">{m.mergePick}</option>
                        {rows.filter((r) => r.id !== row.id).map((r) => (
                          <option key={r.id} value={r.id}>{r.name}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => doMerge(row)}
                        disabled={!mergeInto || busyId === row.id}
                        data-testid="tag-merge-confirm"
                        className="rounded-lg bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40"
                      >
                        {m.mergeConfirm}
                      </button>
                      <span className="text-xs text-gray-500">{m.mergeHint}</span>
                    </div>
                  )}

                  {confirmDelete === row.id && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {/* The count is the point of the confirmation: deleting a
                          label used by 40 people is a different act from
                          deleting one nobody ever applied. */}
                      <span data-testid="tag-delete-warning" className="text-xs text-red-700 dark:text-red-300">
                        {m.deleteWarning.replace('{n}', String(row.usageCount))}
                      </span>
                      <button
                        type="button"
                        onClick={() => doDelete(row)}
                        disabled={busyId === row.id}
                        data-testid="tag-delete-confirm"
                        className="rounded-lg bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-40"
                      >
                        {m.deleteConfirm}
                      </button>
                    </div>
                  )}
                </td>

                <td className="px-4 py-3 text-gray-600 dark:text-gray-300" data-testid={`tag-usage-${row.id}`}>
                  {row.usageCount}
                </td>

                <td className="px-4 py-3">
                  <div className="flex justify-end gap-1.5">
                    {busyId === row.id && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
                    {editing === row.id ? (
                      <>
                        <button type="button" onClick={() => saveEdit(row)} data-testid="tag-edit-save" aria-label={m.save} className="rounded p-1.5 text-green-700 hover:bg-green-50 dark:hover:bg-green-950/40">
                          <Check className="h-4 w-4" />
                        </button>
                        <button type="button" onClick={() => setEditing(null)} aria-label={m.cancel} className="rounded p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800">
                          <X className="h-4 w-4" />
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" onClick={() => startEdit(row)} data-testid={`tag-edit-${row.id}`} aria-label={m.rename} className="rounded p-1.5 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800">
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => { setMerging(merging === row.id ? null : row.id); setEditing(null); setConfirmDelete(null); setMergeInto(''); }}
                          data-testid={`tag-merge-${row.id}`}
                          aria-label={m.merge}
                          disabled={rows.length < 2}
                          className="rounded p-1.5 text-gray-600 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-300 dark:hover:bg-gray-800"
                        >
                          <GitMerge className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => { setConfirmDelete(confirmDelete === row.id ? null : row.id); setEditing(null); setMerging(null); }}
                          data-testid={`tag-delete-${row.id}`}
                          aria-label={m.delete}
                          className="rounded p-1.5 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
