'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Sparkles } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { LoadErrorCard } from '@/components/ui/LoadErrorCard';
import { AiBadge } from '@/components/AiBadge';
import { ArtifactMeta, type ArtifactInfo } from '@/components/ai/ArtifactMeta';
import { useLocale, useT } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';

// /admin/insights (#2046) — the themes behind evaluation comments and the
// weekly-report digest. Every number is drawn from GET /api/admin/insights/*
// and renders with AI off; the summary appears only after "Summarise" (POST),
// or on load when one is stored for exactly the rows in range — a page view
// never spends a call. Each theme opens the rows it was built from: a summary
// you cannot check is worse than none.

type Kind = 'evaluations' | 'weekly-reports';
type Sentiment = 'positive' | 'neutral' | 'negative' | 'unclear';
interface Theme { label: string; count: number; people: number; exampleIds: string[]; sentiment: Sentiment }
type Caveat = { code: 'below_floor'; floor: number; available: number } | { code: 'truncated'; sent: number; available: number } | { code: 'names_masked' } | { code: 'quotes_dropped'; n: number };
interface Source { id: string; text: string; date: string; menteeId: string; menteeName: string; mentorName: string }
interface Body {
  from: string;
  to: string;
  available: number;
  floor: number;
  configured: boolean;
  summary: { themes: Theme[]; overall: Record<Sentiment, number>; notableQuotes: { id: string; text: string }[] } | null;
  cached: boolean;
  artifact: ArtifactInfo | null;
  reason: string | null;
  caveats: Caveat[];
  sources: Source[];
  figures: { weeks: { weekStart: string; submitted: number; withBlockers: number }[]; lastWeekStart: string; notSubmitted: { relationId: string; menteeId: string; menteeName: string; mentorName: string }[] } | null;
}

// `-100` chips stay light in dark mode (globals.css), so `-800` text keeps its contrast.
const TONE: Record<Sentiment, string> = {
  positive: 'bg-green-100 text-green-800',
  neutral: 'bg-gray-100 text-gray-800',
  negative: 'bg-red-100 text-red-800',
  unclear: 'bg-amber-100 text-amber-800',
};

const day = (iso: string) => iso.slice(0, 10);
const fill = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));

function InsightPanel({ kind }: { kind: Kind }) {
  const t = useT();
  const s = t.adminInsights;
  const locale = useLocale();
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [data, setData] = useState<Body | null>(null);
  const [error, setError] = useState(false);
  const [running, setRunning] = useState(false);
  const [open, setOpen] = useState<number | null>(null);

  const query = useCallback((r: { from: string; to: string } | null): Record<string, string> => (r ? { from: `${r.from}T00:00:00.000Z`, to: `${r.to}T23:59:59.999Z` } : {}), []);

  const load = useCallback(async (r: { from: string; to: string } | null) => {
    setError(false);
    try {
      const res = await fetch(`/api/admin/insights/${kind}?${new URLSearchParams(query(r)).toString()}`);
      if (!res.ok) throw new Error(String(res.status));
      const body: Body = await res.json();
      setData(body);
      setOpen(null);
      if (!r) setRange({ from: day(body.from), to: day(body.to) });
    } catch {
      setError(true);
    }
  }, [kind, query]);

  useEffect(() => {
    load(null);
  }, [load]);

  const run = async (regenerate = false) => {
    setRunning(true);
    try {
      const res = await fetch(`/api/admin/insights/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...query(range), regenerate }),
      });
      if (res.ok) {
        setData(await res.json());
        setOpen(null);
      }
    } finally {
      setRunning(false);
    }
  };

  if (error) return <LoadErrorCard onRetry={() => load(range)} />;
  if (!data) return <Card className="p-4"><SkeletonRows rows={4} /></Card>;

  const byId = new Map(data.sources.map((src) => [src.id, src]));
  const reasonText = data.reason && data.reason !== 'below_floor' ? (s.reasons as Record<string, string>)[data.reason] ?? t.common.error : null;
  const caveatText = (c: Caveat) => fill(s.caveats[c.code], c as unknown as Record<string, string | number>);

  return (
    <div className="space-y-4" data-testid={`insights-${kind}`}>
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-gray-600 dark:text-gray-300">
            {s.from}
            <Input type="date" value={range?.from ?? ''} onChange={(e) => setRange((r) => (r ? { ...r, from: e.target.value } : r))} onBlur={() => load(range)} data-testid="insights-from" />
          </label>
          <label className="text-xs text-gray-600 dark:text-gray-300">
            {s.to}
            <Input type="date" value={range?.to ?? ''} onChange={(e) => setRange((r) => (r ? { ...r, to: e.target.value } : r))} onBlur={() => load(range)} data-testid="insights-to" />
          </label>
          <p className="text-sm text-gray-700 dark:text-gray-200" data-testid="insights-available">{fill(s.rows, { n: data.available })}</p>
          {data.configured && data.available >= data.floor && !data.summary && (
            <Button size="sm" onClick={() => run()} loading={running} data-testid="insights-summarise">
              <Sparkles className="mr-1 h-4 w-4" /> {s.summarise}
            </Button>
          )}
        </div>
        {data.reason === 'below_floor' && data.caveats[0] && (
          <p className="mt-3 text-sm text-amber-800 dark:text-amber-300" data-testid="insights-below-floor">{caveatText(data.caveats[0])}</p>
        )}
        {reasonText && <p className="mt-3 text-sm text-amber-800 dark:text-amber-300" data-testid="insights-reason">{reasonText}</p>}
      </Card>

      {data.figures && (
        <Card className="p-4" data-testid="insights-digest">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{s.digest.weekTitle}</h2>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 dark:text-gray-400">
                  <th className="py-1 pr-3 font-medium">{s.digest.week}</th>
                  <th className="py-1 pr-3 font-medium">{s.digest.submitted}</th>
                  <th className="py-1 font-medium">{s.digest.withBlockers}</th>
                </tr>
              </thead>
              <tbody>
                {data.figures.weeks.map((w) => (
                  <tr key={w.weekStart} className="border-t border-gray-100 dark:border-gray-800">
                    <td className="py-1 pr-3">{formatDate(w.weekStart, locale, { timeZone: 'UTC' })}</td>
                    <td className="py-1 pr-3">{w.submitted}</td>
                    <td className="py-1">{w.withBlockers}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 className="mt-4 text-sm font-semibold text-gray-900 dark:text-gray-100">
            {fill(s.digest.notSubmittedTitle, { date: formatDate(data.figures.lastWeekStart, locale, { timeZone: 'UTC' }) })}
          </h3>
          {data.figures.notSubmitted.length === 0 ? (
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{s.digest.allIn}</p>
          ) : (
            <ul className="mt-1 flex flex-wrap gap-2" data-testid="insights-not-submitted">
              {data.figures.notSubmitted.map((n) => (
                <li key={n.relationId}>
                  <Link href={`/admin/candidates/${n.menteeId}`} className="inline-block rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-800 hover:underline">
                    {n.menteeName} · {n.mentorName}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {data.summary && (
        <Card className="p-4" data-testid="insights-summary">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{s.themesTitle}</h2>
            <AiBadge note />
          </div>
          <ul className="mt-3 space-y-3">
            {data.summary.themes.map((theme, i) => (
              <li key={`${theme.label}-${i}`} className="rounded-lg border border-gray-200 p-3 dark:border-gray-700" data-testid="insights-theme">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-gray-900 dark:text-gray-100">{theme.label}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] ${TONE[theme.sentiment]}`}>{s.sentiment[theme.sentiment]}</span>
                  {theme.people > 1 && <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] text-blue-800">{s.recurring}</span>}
                </div>
                <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">{fill(s.themeCount, { count: theme.count, people: theme.people })}</p>
                <button type="button" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i} className="mt-1 text-xs text-blue-700 hover:underline dark:text-blue-300" data-testid="insights-theme-toggle">
                  {open === i ? s.hideRows : fill(s.showRows, { n: theme.count })}
                </button>
                {open === i && (
                  <ul className="mt-2 space-y-2" data-testid="insights-theme-rows">
                    {theme.exampleIds.map((id) => {
                      const src = byId.get(id);
                      if (!src) return null;
                      return (
                        <li key={id} className="rounded bg-gray-50 p-2 text-sm text-gray-800 dark:bg-gray-800/60 dark:text-gray-200">
                          <p className="whitespace-pre-line">{src.text}</p>
                          <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
                            {src.menteeName} · {src.mentorName} · {formatDate(src.date, locale)} ·{' '}
                            <Link href={`/admin/candidates/${src.menteeId}`} className="text-blue-700 hover:underline dark:text-blue-300">{s.openRecord}</Link>
                          </p>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            ))}
          </ul>

          <h3 className="mt-4 text-sm font-semibold text-gray-900 dark:text-gray-100">{s.overallTitle}</h3>
          <div className="mt-1 flex flex-wrap gap-2" data-testid="insights-overall">
            {(['positive', 'neutral', 'negative', 'unclear'] as const).map((k) => (
              <span key={k} className={`rounded-full px-2 py-0.5 text-xs ${TONE[k]}`}>{s.sentiment[k]}: {data.summary!.overall[k]}</span>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">{s.overallNote}</p>

          {data.summary.notableQuotes.length > 0 && (
            <>
              <h3 className="mt-4 text-sm font-semibold text-gray-900 dark:text-gray-100">{s.quotesTitle}</h3>
              <ul className="mt-1 space-y-1">
                {data.summary.notableQuotes.map((q, i) => (
                  <li key={`${q.id}-${i}`} className="text-sm italic text-gray-700 dark:text-gray-200">“{q.text}”</li>
                ))}
              </ul>
            </>
          )}

          {data.caveats.length > 0 && (
            <ul className="mt-3 space-y-0.5" data-testid="insights-caveats">
              {data.caveats.map((c, i) => (
                <li key={i} className="text-[11px] text-gray-500 dark:text-gray-400">{caveatText(c)}</li>
              ))}
            </ul>
          )}
          {data.artifact && <ArtifactMeta key={data.artifact.id} artifact={data.artifact} cached={data.cached} onRegenerate={data.configured ? () => run(true) : undefined} regenerating={running} />}
        </Card>
      )}
    </div>
  );
}

export default function AdminInsightsPage() {
  const t = useT();
  const s = t.adminInsights;
  const [kind, setKind] = useState<Kind>('evaluations');
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{s.title}</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{s.intro}</p>
      </div>
      <div role="tablist" className="flex gap-2">
        {(['evaluations', 'weekly-reports'] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={kind === k}
            onClick={() => setKind(k)}
            data-testid={`insights-tab-${k}`}
            className={`rounded-full px-3 py-1 text-sm ${kind === k ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-800 hover:bg-gray-200'}`}
          >
            {k === 'evaluations' ? s.tabs.evaluations : s.tabs.weeklyReports}
          </button>
        ))}
      </div>
      <InsightPanel key={kind} kind={kind} />
    </div>
  );
}
