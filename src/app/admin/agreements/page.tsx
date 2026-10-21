'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useLocale, useT } from '@/i18n/client';
import { intlLocaleFor } from '@/lib/interviewRequests';

// The mentoring agreement editor (#1790). Every save publishes a NEW version
// (the server numbers it); there is no edit control because there is no edit
// path — the API refuses PATCH. Acceptance at kickoff is #1792.

const LOCALES = ['en', 'tr', 'de'] as const;
type Loc = (typeof LOCALES)[number];

interface Version {
  version: string;
  effectiveFrom: string;
  acceptances: number;
  texts: { locale: string; isAuthoritative: boolean; body: string }[];
}
interface PairRow { relationId: string; mentorName: string; menteeName: string; mentorAcceptedAt: string | null; menteeAcceptedAt: string | null }

export default function AdminAgreementsPage() {
  const t = useT();
  const A = t.agreementsAdmin;
  const locale = useLocale();
  const [versions, setVersions] = useState<Version[]>([]);
  const [report, setReport] = useState<{ version: string | null; relations: PairRow[] } | null>(null);
  const [bodies, setBodies] = useState<Record<Loc, string>>({ en: '', tr: '', de: '' });
  const [authoritative, setAuthoritative] = useState<Loc>('en');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/agreements');
    if (!res.ok) return;
    const body = await res.json();
    setVersions(body.versions);
    setReport(body.report);
    // The editor starts from the newest version's text, so a change is an edit of what is in force.
    const newest: Version | undefined = body.versions[0];
    if (newest) {
      const next = { en: '', tr: '', de: '' } as Record<Loc, string>;
      for (const tx of newest.texts) if ((LOCALES as readonly string[]).includes(tx.locale)) next[tx.locale as Loc] = tx.body;
      setBodies(next);
      const auth = newest.texts.find((x) => x.isAuthoritative)?.locale;
      if (auth && (LOCALES as readonly string[]).includes(auth)) setAuthoritative(auth as Loc);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const fmt = (iso: string) => new Date(iso).toLocaleDateString(intlLocaleFor(locale), { year: 'numeric', month: 'short', day: 'numeric' });

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/agreements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bodies, authoritativeLocale: authoritative, ...(effectiveFrom ? { effectiveFrom: new Date(`${effectiveFrom}T00:00:00Z`).toISOString() } : {}) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = body.code as keyof typeof A.errors;
        setMessage({ ok: false, text: A.errors[code] ?? A.errors.generic });
        return;
      }
      setMessage({ ok: true, text: A.saved.replace('{version}', body.version) });
      await load();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{A.title}</h1>
        <p className="mt-1 text-gray-500">{A.subtitle}</p>
        {report?.version && <p className="mt-2 text-sm text-gray-600" data-testid="agreement-current">{A.current.replace('{version}', report.version)}</p>}
      </div>

      <Card>
        <CardHeader><CardTitle>{A.newVersion}</CardTitle></CardHeader>
        <form onSubmit={save} className="space-y-4" data-testid="agreement-form">
          {LOCALES.map((l) => (
            <label key={l} className="block">
              <span className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">{A.textFor.replace('{locale}', l.toUpperCase())}</span>
              <textarea
                data-testid={`agreement-body-${l}`}
                value={bodies[l]}
                onChange={(e) => setBodies((b) => ({ ...b, [l]: e.target.value }))}
                rows={8}
                maxLength={20000}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
              />
            </label>
          ))}
          <div className="grid gap-3 sm:grid-cols-2">
            <Select label={A.authoritative} hint={A.authoritativeHint} value={authoritative} onChange={(e) => setAuthoritative(e.target.value as Loc)} options={LOCALES.map((l) => ({ value: l, label: l.toUpperCase() }))} data-testid="agreement-authoritative" />
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">{A.effectiveFrom}</span>
              <input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" data-testid="agreement-effective" />
            </label>
          </div>
          {message && <p role={message.ok ? 'status' : 'alert'} className={message.ok ? 'text-sm text-green-700' : 'text-sm text-red-600'} data-testid="agreement-message">{message.text}</p>}
          <Button type="submit" loading={saving} data-testid="agreement-save">{A.newVersion}</Button>
        </form>
      </Card>

      <Card>
        <CardHeader><CardTitle>{A.versions} ({versions.length})</CardTitle></CardHeader>
        {versions.length === 0 ? <SkeletonRows rows={2} /> : (
          <ul className="divide-y divide-gray-100" data-testid="agreement-versions">
            {versions.map((v) => (
              <li key={v.version} className="flex flex-wrap items-center gap-2 py-2 text-sm" data-testid={`agreement-version-${v.version}`}>
                <span className="font-medium text-gray-900 dark:text-gray-100">{A.version.replace('{version}', v.version)}</span>
                <span className="text-gray-500">{fmt(v.effectiveFrom)}</span>
                {v.texts.map((x) => <Badge key={x.locale} variant={x.isAuthoritative ? 'info' : 'default'}>{x.locale.toUpperCase()}{x.isAuthoritative ? ` · ${A.binding}` : ''}</Badge>)}
                <span className="text-gray-500">{A.acceptances.replace('{n}', String(v.acceptances))}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader><CardTitle>{A.pairings}</CardTitle></CardHeader>
        {!report ? <SkeletonRows rows={3} /> : report.relations.length === 0 ? <p className="text-sm text-gray-400">{A.noPairings}</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="agreement-report">
              <thead>
                <tr className="border-b border-gray-100 text-left text-gray-500">
                  <th className="py-2 pr-4">{A.menteeSide}</th>
                  <th className="py-2 pr-4">{A.mentorSide}</th>
                </tr>
              </thead>
              <tbody>
                {report.relations.map((r) => (
                  <tr key={r.relationId} className="border-b border-gray-50">
                    <td className="py-2 pr-4">{r.menteeName} · <span className={r.menteeAcceptedAt ? 'text-green-700' : 'text-gray-500'}>{r.menteeAcceptedAt ? `${A.accepted} ${fmt(r.menteeAcceptedAt)}` : A.notYet}</span></td>
                    <td className="py-2 pr-4">{r.mentorName} · <span className={r.mentorAcceptedAt ? 'text-green-700' : 'text-gray-500'}>{r.mentorAcceptedAt ? `${A.accepted} ${fmt(r.mentorAcceptedAt)}` : A.notYet}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
