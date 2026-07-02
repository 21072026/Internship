'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Trash2 } from 'lucide-react';
import { useT } from '@/i18n/client';

interface Hook { id: string; url: string; events: string[]; active: boolean }
interface Key { id: string; name: string; lastUsedAt: string | null; createdAt: string }

export default function IntegrationsPage() {
  const t = useT();
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [eventTypes, setEventTypes] = useState<string[]>([]);
  const [keys, setKeys] = useState<Key[]>([]);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>([]);
  const [secret, setSecret] = useState('');
  const [keyName, setKeyName] = useState('');
  const [newKey, setNewKey] = useState('');

  const load = useCallback(async () => {
    const [w, k] = await Promise.all([fetch('/api/admin/webhooks'), fetch('/api/admin/api-keys')]);
    if (w.ok) { const d = await w.json(); setHooks(d.webhooks ?? []); setEventTypes(d.eventTypes ?? []); }
    if (k.ok) setKeys((await k.json()).keys ?? []);
  }, []);
  useEffect(() => { load(); }, [load]);

  const addHook = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url || events.length === 0) return;
    const res = await fetch('/api/admin/webhooks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, events }),
    });
    if (res.ok) { const d = await res.json(); setSecret(d.secret); setUrl(''); setEvents([]); await load(); }
  };
  const delHook = async (id: string) => { await fetch(`/api/admin/webhooks?id=${id}`, { method: 'DELETE' }); await load(); };

  const addKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!keyName) return;
    const res = await fetch('/api/admin/api-keys', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: keyName }),
    });
    if (res.ok) { const d = await res.json(); setNewKey(d.key); setKeyName(''); await load(); }
  };
  const delKey = async (id: string) => { await fetch(`/api/admin/api-keys?id=${id}`, { method: 'DELETE' }); await load(); };

  const toggleEvent = (ev: string) => setEvents((p) => (p.includes(ev) ? p.filter((x) => x !== ev) : [...p, ev]));

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{t.integrations.title}</h1>
        <p className="text-gray-500 mt-1">{t.integrations.subtitle}</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle>{t.integrations.webhooks}</CardTitle></CardHeader>
          {secret && (
            <div className="mb-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 break-all">
              {t.integrations.secretOnce}: <code>{secret}</code>
            </div>
          )}
          <form onSubmit={addHook} className="space-y-2 mb-4">
            <Input placeholder="https://example.com/webhook" value={url} onChange={(e) => setUrl(e.target.value)} />
            <div className="flex flex-wrap gap-3">
              {eventTypes.map((ev) => (
                <label key={ev} className="flex items-center gap-1.5 text-xs text-gray-700">
                  <input type="checkbox" checked={events.includes(ev)} onChange={() => toggleEvent(ev)} /> {ev}
                </label>
              ))}
            </div>
            <Button type="submit" size="sm" disabled={!url || events.length === 0}>{t.integrations.addWebhook}</Button>
          </form>
          {hooks.length === 0 ? <p className="text-sm text-gray-400">{t.integrations.noWebhooks}</p> : (
            <div className="divide-y divide-gray-50">
              {hooks.map((h) => (
                <div key={h.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <div className="min-w-0">
                    <p className="truncate text-gray-900">{h.url}</p>
                    <p className="text-xs text-gray-400">{h.events.join(', ')}</p>
                  </div>
                  <button onClick={() => delHook(h.id)} aria-label="delete" className="p-1.5 text-gray-400 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <CardHeader><CardTitle>{t.integrations.apiKeys}</CardTitle></CardHeader>
          {newKey && (
            <div className="mb-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 break-all">
              {t.integrations.keyOnce}: <code>{newKey}</code>
            </div>
          )}
          <form onSubmit={addKey} className="flex gap-2 mb-4">
            <Input placeholder={t.integrations.keyName} value={keyName} onChange={(e) => setKeyName(e.target.value)} />
            <Button type="submit" size="sm" disabled={!keyName}>{t.integrations.generate}</Button>
          </form>
          {keys.length === 0 ? <p className="text-sm text-gray-400">{t.integrations.noKeys}</p> : (
            <div className="divide-y divide-gray-50">
              {keys.map((k) => (
                <div key={k.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <div>
                    <p className="text-gray-900">{k.name}</p>
                    <p className="text-xs text-gray-400">{k.lastUsedAt ? `${t.integrations.lastUsed}: ${new Date(k.lastUsedAt).toLocaleDateString()}` : t.integrations.neverUsed}</p>
                  </div>
                  <button onClick={() => delKey(k.id)} aria-label="revoke" className="p-1.5 text-gray-400 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-gray-400 mt-3">{t.integrations.apiHint} <code>GET /api/v1/candidates</code></p>
          <Link href="/admin/api-docs" className="inline-block text-sm text-blue-600 hover:underline mt-2">{t.integrations.apiDocsLink} →</Link>
        </Card>
      </div>
    </div>
  );
}
