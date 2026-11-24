'use client';
import { useEffect, useState } from 'react';
import { useT } from '@/i18n/client';

type Row = { id: string; email: string; role: 'MENTEE'|'MENTOR'|'COMPANY'|'OTHER'; locale: string; confirmedAt: string|null; unsubscribedAt: string|null; utmSource: string|null; utmCampaign: string|null };
export default function SubscribersPage() {
  const t = useT().interest;
  const [rows, setRows] = useState<Row[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => { fetch('/api/admin/subscribers').then(async res => {
    if (!res.ok) throw new Error(); setRows((await res.json()).items);
  }).catch(() => setFailed(true)); }, []);
  return <div className="p-6"><h1 className="text-2xl font-bold">{t.adminTitle}</h1>
    <a className="my-4 inline-block text-blue-600 underline" href="/api/admin/subscribers?format=csv">{t.export}</a>
    {failed ? <p role="alert">{t.loadError}</p> : <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{[t.email,t.role,t.state,t.source].map(label => <th key={label} className="p-3">{label}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.id} className="border-t"><td className="p-3">{row.email} · {row.locale}</td><td className="p-3">{t.roles[row.role]}</td><td className="p-3">{row.unsubscribedAt ? t.withdrawn : row.confirmedAt ? t.confirmed : t.pending}</td><td className="p-3">{[row.utmSource,row.utmCampaign].filter(Boolean).join(' / ') || '—'}</td></tr>)}</tbody></table>{!rows.length && <p>{t.empty}</p>}</div>}
  </div>;
}
