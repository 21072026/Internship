'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { CHANNEL_STATUSES, SALES_CHANNELS, channelLabel, type ChannelStatus } from '@/lib/salesChannels';

// The ADMIN's sales-channel editor on /admin/companies/[id] (#2408): add a
// channel, change its status, remove it. The vocabulary is the one list in
// src/lib/salesChannels.ts; the route re-checks every value.

export interface CompanyChannelsLabels {
  channel: string;
  status: string;
  add: string;
  remove: string;
  failed: string;
  none: string;
  hint: string;
  statuses: Record<ChannelStatus, string>;
  kinds: Record<'MARKETPLACE' | 'SHOP' | 'CARRIER', string>;
}

const select = 'rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900';

export function CompanyChannelsEditor({
  companyId,
  channels,
  labels,
}: {
  companyId: string;
  channels: { channel: string; status: string }[];
  labels: CompanyChannelsLabels;
}) {
  const router = useRouter();
  const taken = new Set(channels.map((c) => c.channel));
  const free = SALES_CHANNELS.filter((c) => !taken.has(c.key));
  const [channel, setChannel] = useState('');
  const [status, setStatus] = useState<ChannelStatus>('USING');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const send = async (method: 'PUT' | 'DELETE', body: Record<string, string>) => {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch(`/api/admin/companies/${companyId}/channels`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setFailed(true);
        return;
      }
      setChannel('');
      router.refresh();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="company-channels-editor">
      <p className="mb-3 text-xs text-gray-500">{labels.hint}</p>
      {channels.length === 0 ? (
        <p className="mb-3 text-sm text-gray-500">{labels.none}</p>
      ) : (
        <ul className="mb-4 divide-y divide-gray-100 dark:divide-gray-800">
          {channels.map((c) => (
            <li key={c.channel} className="flex items-center justify-between gap-3 py-2" data-testid={`company-channel-${c.channel}`}>
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{channelLabel(c.channel)}</span>
              <span className="flex items-center gap-2">
                <select
                  className={select}
                  aria-label={`${labels.status}: ${channelLabel(c.channel)}`}
                  value={c.status}
                  disabled={busy}
                  data-testid={`company-channel-status-${c.channel}`}
                  onChange={(e) => void send('PUT', { channel: c.channel, status: e.target.value })}
                >
                  {CHANNEL_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {labels.statuses[s]}
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`${labels.remove}: ${channelLabel(c.channel)}`}
                  disabled={busy}
                  data-testid={`company-channel-remove-${c.channel}`}
                  onClick={() => void send('DELETE', { channel: c.channel })}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {free.length > 0 && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (channel) void send('PUT', { channel, status });
          }}
        >
          <label className="text-xs text-gray-500">
            {labels.channel}
            <select className={`${select} mt-1 block`} value={channel} onChange={(e) => setChannel(e.target.value)} data-testid="company-channel-new">
              <option value="">—</option>
              {(['MARKETPLACE', 'SHOP', 'CARRIER'] as const).map((kind) => (
                <optgroup key={kind} label={labels.kinds[kind]}>
                  {free
                    .filter((c) => c.kind === kind)
                    .map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.label}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </label>
          <label className="text-xs text-gray-500">
            {labels.status}
            <select className={`${select} mt-1 block`} value={status} onChange={(e) => setStatus(e.target.value as ChannelStatus)}>
              {CHANNEL_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {labels.statuses[s]}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" size="sm" loading={busy} disabled={!channel} data-testid="company-channel-add">
            {labels.add}
          </Button>
        </form>
      )}
      {failed && <p className="mt-2 text-sm text-red-700">{labels.failed}</p>}
    </div>
  );
}
