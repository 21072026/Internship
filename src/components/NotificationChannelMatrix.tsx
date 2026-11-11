'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/i18n/client';
import { Button } from '@/components/ui/Button';
import { interpolate } from '@/lib/notificationText';

// The category × channel grid and the quiet-hours row (#1714,
// docs/notification-channels.md). Reads and writes only
// /api/account/notification-channels, which MERGES into notificationPrefs —
// so, unlike the switch lists above it in AccountSettings, a click here can
// never overwrite another key of the blob.

type Channel = 'inApp' | 'email' | 'push';
interface Cell { channel: Channel; default: boolean; value: boolean | null; settable: boolean }
interface View {
  categories: { id: string; channels: Cell[] }[];
  quietHours: { start: string; end: string; tz?: string } | null;
  timezone: string | null;
}

export function NotificationChannelMatrix() {
  const t = useT();
  const m = t.account.channelMatrix;
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [quietOn, setQuietOn] = useState(false);
  const [start, setStart] = useState('21:00');
  const [end, setEnd] = useState('08:00');
  const [quietMsg, setQuietMsg] = useState<string | null>(null);

  const apply = useCallback((v: View) => {
    setView(v);
    setQuietOn(!!v.quietHours);
    if (v.quietHours) {
      setStart(v.quietHours.start);
      setEnd(v.quietHours.end);
    }
  }, []);

  useEffect(() => {
    fetch('/api/account/notification-channels')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(apply)
      .catch(() => setError(t.account.prefsLoadFailed));
  }, [apply, t.account.prefsLoadFailed]);

  const put = async (body: object): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/account/notification-channels', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(String(res.status));
      apply(await res.json());
      return true;
    } catch {
      setError(m.saveFailed);
      return false;
    } finally {
      setSaving(false);
    }
  };

  // Back to the catalogue default (null) when the choice equals it, so the
  // stored overrides stay sparse and a later default change still reaches
  // everyone who never deviated from it.
  const toggle = async (category: string, cell: Cell, next: boolean) => {
    const value = next === cell.default ? null : next;
    const previous = view;
    // Optimistic, rolled back on failure — the same shape as the switch lists
    // in AccountSettings, so the box moves under the pointer.
    setView((v) =>
      v && {
        ...v,
        categories: v.categories.map((r) =>
          r.id !== category ? r : { ...r, channels: r.channels.map((c) => (c.channel === cell.channel ? { ...c, value } : c)) },
        ),
      },
    );
    if (!(await put({ channels: { [category]: { [cell.channel]: value } } }))) setView(previous);
  };

  const saveQuiet = async () => {
    setQuietMsg(null);
    if (quietOn && start === end) {
      setQuietMsg(m.quietInvalid);
      return;
    }
    const ok = await put({ quietHours: quietOn ? { start, end } : null });
    if (ok) setQuietMsg(m.quietSaved);
  };

  const labels = t.account.notifCategories as Record<string, string>;
  const zone = view?.timezone ?? 'UTC';

  return (
    <section className="mt-4 pt-4 border-t border-gray-100" data-testid="channel-matrix-section">
      <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">{m.title}</h4>
      <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">{m.hint}</p>
      {error && (
        <p className="text-xs text-red-600 mt-2" role="status" data-testid="channel-matrix-error">{error}</p>
      )}
      {view && (
        <div className="mt-3 overflow-x-auto">
          <table className="text-sm text-gray-600 dark:text-gray-300" data-testid="channel-matrix">
            <thead>
              <tr>
                <th scope="col" className="text-left font-medium pr-4 pb-1">{m.category}</th>
                <th scope="col" className="font-medium px-3 pb-1">{m.inApp}</th>
                <th scope="col" className="font-medium px-3 pb-1">{m.email}</th>
                <th scope="col" className="font-medium px-3 pb-1">{m.push}</th>
              </tr>
            </thead>
            <tbody>
              {view.categories.map((row) => (
                <tr key={row.id}>
                  <th scope="row" className="text-left font-normal pr-4 py-1">{labels[row.id] ?? row.id}</th>
                  {row.channels.map((cell) => (
                    <td key={cell.channel} className="text-center px-3 py-1">
                      <input
                        type="checkbox"
                        aria-label={`${labels[row.id] ?? row.id} — ${m[cell.channel]}`}
                        data-testid={`channel-${row.id}-${cell.channel}`}
                        checked={cell.settable && (cell.value ?? cell.default)}
                        disabled={saving || !cell.settable}
                        onChange={(e) => toggle(row.id, cell, e.target.checked)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {view && (
        <div className="mt-4" data-testid="quiet-hours">
          <h5 className="text-sm font-medium text-gray-700 dark:text-gray-300">{m.quietTitle}</h5>
          <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">{m.quietHint}</p>
          <label className="mt-2 flex items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              data-testid="quiet-hours-toggle"
              checked={quietOn}
              disabled={saving}
              onChange={(e) => setQuietOn(e.target.checked)}
            />
            {m.quietEnable}
          </label>
          <div className="mt-2 flex flex-wrap items-end gap-3 pl-6">
            <label className="text-xs text-gray-600 dark:text-gray-400">
              {m.quietFrom}
              <input
                type="time"
                className="block mt-1 rounded border border-gray-300 px-2 py-1 text-sm bg-white dark:bg-gray-800"
                data-testid="quiet-hours-start"
                value={start}
                disabled={!quietOn || saving}
                onChange={(e) => setStart(e.target.value)}
              />
            </label>
            <label className="text-xs text-gray-600 dark:text-gray-400">
              {m.quietTo}
              <input
                type="time"
                className="block mt-1 rounded border border-gray-300 px-2 py-1 text-sm bg-white dark:bg-gray-800"
                data-testid="quiet-hours-end"
                value={end}
                disabled={!quietOn || saving}
                onChange={(e) => setEnd(e.target.value)}
              />
            </label>
            <Button type="button" size="sm" onClick={saveQuiet} disabled={saving} data-testid="quiet-hours-save">
              {m.quietSave}
            </Button>
          </div>
          <p className="text-xs text-gray-500 mt-1 pl-6">{interpolate(m.quietZone, { zone })}</p>
          {quietMsg && (
            <p className="text-xs text-gray-600 mt-1 pl-6" role="status" data-testid="quiet-hours-status">{quietMsg}</p>
          )}
        </div>
      )}
    </section>
  );
}
