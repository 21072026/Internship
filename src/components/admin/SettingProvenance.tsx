'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useT } from '@/i18n/client';
import type { SettingSource } from '@/lib/settings';

// Where one setting's value comes from, what happened to it, and the way back
// to the inherited value (#1623).
//
//   * the badge reads the layer `resolveSettings()` picked the value from;
//   * "History" lists who · when · old → new from GET /api/admin/settings/history
//     (the caller's org only — the route takes the org from the session);
//   * "Revert to inherited" is offered only when the value is set at this
//     layer, and DELETEs that row (it never copies the parent's value, so a
//     later change upstream keeps flowing down). The parent reloads the form.

type HistoryItem = {
  id: string;
  oldValue: string | null;
  newValue: string | null;
  createdAt: string;
  actor: { name?: string; email?: string; operator?: true; system?: true };
};

export function SettingProvenance({
  settingKey,
  source,
  onReverted,
}: {
  settingKey: string;
  source: SettingSource | undefined;
  onReverted: () => void;
}) {
  const t = useT().settings.provenance;
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [revertError, setRevertError] = useState(false);
  if (!source) return null;

  const setHere = source === 'org' || source === 'program';
  const label = setHere ? t.setHere : source === 'global' ? t.inheritedGlobal : t.inheritedDefault;

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next) return;
    setFailed(false);
    const res = await fetch(`/api/admin/settings/history?key=${encodeURIComponent(settingKey)}&limit=10`).catch(() => null);
    const body = res?.ok ? await res.json().catch(() => null) : null;
    if (!body?.items) {
      setFailed(true);
      return;
    }
    setItems(body.items);
  };

  const revert = async () => {
    setReverting(true);
    setRevertError(false);
    const res = await fetch(`/api/admin/settings?key=${encodeURIComponent(settingKey)}`, { method: 'DELETE' }).catch(() => null);
    setReverting(false);
    if (!res?.ok) {
      setRevertError(true);
      return;
    }
    setItems(null);
    setOpen(false);
    onReverted();
  };

  const show = (v: string | null) => (v === null || v === '' ? t.unset : v);
  const who = (a: HistoryItem['actor']) => (a.name || a.email ? (a.name ?? a.email) : a.operator ? t.operator : t.system);

  return (
    <div className="mt-1 text-xs" data-testid={`setting-provenance-${settingKey}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={setHere ? 'info' : 'default'} data-testid={`setting-source-${settingKey}`} data-source={source}>
          {label}
        </Badge>
        <button type="button" className="text-blue-600 dark:text-blue-400 hover:underline" onClick={toggle} aria-expanded={open} data-testid={`setting-history-toggle-${settingKey}`}>
          {t.history}
        </button>
        {source === 'org' && (
          <button
            type="button"
            className="text-gray-600 dark:text-gray-300 hover:underline disabled:opacity-50"
            onClick={revert}
            disabled={reverting}
            data-testid={`setting-revert-${settingKey}`}
          >
            {t.revert}
          </button>
        )}
      </div>
      {revertError && <p className="text-red-600 mt-1" role="alert">{t.revertFailed}</p>}
      {open && (
        <div className="mt-1" data-testid={`setting-history-${settingKey}`}>
          {failed ? (
            <p className="text-red-600">{t.historyFailed}</p>
          ) : items === null ? null : items.length === 0 ? (
            <p className="text-gray-500">{t.historyEmpty}</p>
          ) : (
            <ul className="space-y-0.5 text-gray-600 dark:text-gray-300">
              {items.map((item) => (
                <li key={item.id} data-testid="setting-history-row">
                  {who(item.actor)} · <RelativeTime date={item.createdAt} /> · {show(item.oldValue)} → {show(item.newValue)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
