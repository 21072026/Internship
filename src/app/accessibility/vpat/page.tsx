import type { Metadata } from 'next';
import Link from 'next/link';
import { pageMetadata } from '@/lib/pageMetadata';
import { getServerDictionary } from '@/i18n/server';
import { PublicShell } from '@/components/landing/PublicShell';
import { GITHUB_URL } from '@/components/landing/links';
import { CONFORMANCE_LEVELS, type Conformance, type VpatRow, type VpatSection } from '@/lib/vpat';
import { conformanceSummary, evidenceMarkdown } from '@/lib/vpatRender';
import { vpatDocument } from '@/lib/vpatDocument';
import { VPAT_EVIDENCE } from '@/lib/vpatEvidence.generated';

export async function generateMetadata(): Promise<Metadata> {
  return pageMetadata((t) => ({ title: t.accessibility.vpat.title, description: t.accessibility.vpat.subtitle }));
}

// The conformance report (#2037), rendered from src/lib/vpat.ts — the same rows
// docs/legal/vpat.md and /accessibility/vpat.md carry. The chrome around the
// tables is translated; the report itself is English (the criteria and the four
// conformance terms are defined in English, and a reviewer compares it against
// other vendors' reports in that form). Public: it names no person.
const TONE: Record<Conformance, string> = {
  Supports: 'bg-green-50 text-green-800 border-green-200 dark:bg-green-950/40 dark:text-green-200 dark:border-green-800',
  'Partially Supports': 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:border-amber-800',
  'Does Not Support': 'bg-red-50 text-red-800 border-red-200 dark:bg-red-950/40 dark:text-red-200 dark:border-red-800',
  'Not Applicable': 'bg-gray-50 text-gray-700 border-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:border-gray-700',
};

/** One evidence entry as a link (path, issue) or inline text (`check:`). */
function Evidence({ entry }: { entry: string }) {
  const md = evidenceMarkdown(entry, GITHUB_URL);
  const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(md);
  if (!link) return <span className="font-mono text-[11px]">{entry.replace(/^check:\s*/, 'check: ')}</span>;
  const label = link[1].replace(/`/g, '');
  return (
    <a href={link[2]} target="_blank" rel="noopener noreferrer" className="font-mono text-[11px] text-blue-600 underline underline-offset-2 break-all">
      {label}
    </a>
  );
}

function RowsTable({ rows, columns, withLevel, testId }: { rows: VpatRow[]; columns: { criteria: string; level: string; conformance: string; remarks: string; evidence: string }; withLevel: boolean; testId: string }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800">
      <table className="w-full text-xs" data-testid={testId}>
        <thead>
          <tr className="bg-gray-50 dark:bg-gray-800/60 text-left text-gray-600 dark:text-gray-300">
            <th scope="col" className="px-3 py-2 font-medium">{columns.criteria}</th>
            {withLevel && <th scope="col" className="px-3 py-2 font-medium">{columns.level}</th>}
            <th scope="col" className="px-3 py-2 font-medium">{columns.conformance}</th>
            <th scope="col" className="px-3 py-2 font-medium">{columns.remarks}</th>
            <th scope="col" className="px-3 py-2 font-medium">{columns.evidence}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-gray-100 dark:border-gray-800 align-top" data-testid={`vpat-row-${r.id}`}>
              <th scope="row" className="px-3 py-2 font-medium text-gray-900 dark:text-gray-100 whitespace-nowrap text-left">
                {r.id} <span className="font-normal">{r.name}</span>
              </th>
              {withLevel && <td className="px-3 py-2 text-gray-700 dark:text-gray-300">{r.level}</td>}
              <td className="px-3 py-2">
                <span className={`inline-block whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] font-medium ${TONE[r.conformance]}`}>{r.conformance}</span>
              </td>
              <td className="px-3 py-2 text-gray-700 dark:text-gray-300 min-w-[18rem]">{r.remarks}</td>
              <td className="px-3 py-2 min-w-[12rem]">
                {r.evidence.length === 0 ? (
                  <span className="text-gray-400">—</span>
                ) : (
                  <ul className="space-y-0.5">
                    {r.evidence.map((e) => (
                      <li key={e}><Evidence entry={e} /></li>
                    ))}
                  </ul>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function VpatPage() {
  const { t } = await getServerDictionary();
  const v = t.accessibility.vpat;
  const doc = vpatDocument();
  const evidence = VPAT_EVIDENCE;
  const a = doc.wcag.filter((r) => r.level === 'A');
  const aa = doc.wcag.filter((r) => r.level === 'AA');
  const aaa = doc.wcag.filter((r) => r.level === 'AAA');
  const summary = conformanceSummary([...a, ...aa]);
  const pages = evidence.pages.filter((p) => p.theme === 'light').map((p) => p.path);
  const openGated = evidence.pages.reduce((n, p) => n + Object.values(p.violations).reduce((s, x) => s + x, 0), 0);
  const columns = v.columns;

  // Both standards have a "Chapter 5", so the test id carries the standard too.
  const section = (standard: 's508' | 'en', s: VpatSection, extra: VpatRow[] = []) => (
    <section key={`${standard}-${s.id}`} className="space-y-2">
      <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{s.id}: {s.title}</h3>
      {s.note && <p className="text-xs text-gray-600 dark:text-gray-300">{s.note}</p>}
      <RowsTable rows={[...extra, ...s.rows]} columns={columns} withLevel={false} testId={`vpat-table-${standard}-${s.id.replace(/\s+/g, '-').toLowerCase()}`} />
    </section>
  );

  return (
    <PublicShell breadcrumb={{ name: v.title, path: '/accessibility/vpat' }}>
      <div className="max-w-6xl mx-auto my-12 px-4">
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-6 sm:p-8 space-y-8">
          <header>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{v.title}</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{v.subtitle}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-3">{v.englishNote}</p>
            <p className="mt-4 flex flex-wrap gap-4 text-sm">
              <a href="/accessibility/vpat.md" className="text-blue-600 underline underline-offset-2" data-testid="vpat-download">
                {v.downloadMarkdown}
              </a>
              <Link href="/accessibility" className="text-blue-600 underline underline-offset-2" data-testid="vpat-back">
                {v.backToStatement}
              </Link>
            </p>
          </header>

          <dl className="grid gap-3 sm:grid-cols-2 text-sm text-gray-700 dark:text-gray-300" data-testid="vpat-meta">
            <div><dt className="font-medium text-gray-900 dark:text-gray-100">{v.productLabel}</dt><dd>{doc.meta.product}</dd></div>
            <div><dt className="font-medium text-gray-900 dark:text-gray-100">{v.dateLabel}</dt><dd>{doc.meta.reportDate}</dd></div>
            <div><dt className="font-medium text-gray-900 dark:text-gray-100">{v.versionLabel}</dt><dd>{doc.meta.versionNote}</dd></div>
            <div><dt className="font-medium text-gray-900 dark:text-gray-100">{v.contactLabel}</dt><dd>{doc.meta.contactNote}</dd></div>
            <div className="sm:col-span-2"><dt className="font-medium text-gray-900 dark:text-gray-100">{v.notesLabel}</dt><dd>{doc.meta.notes}</dd></div>
          </dl>

          <section className="space-y-2">
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{v.methodsTitle}</h2>
            <ul className="list-disc pl-5 space-y-1 text-sm text-gray-700 dark:text-gray-300">
              {doc.meta.evaluationMethods.map((m) => <li key={m}>{m}</li>)}
            </ul>
            <div className="rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 px-4 py-3 text-sm text-amber-900 dark:text-amber-100" data-testid="vpat-scope">
              <p className="font-medium">{v.scopeTitle}</p>
              <p className="mt-1">{v.scopeBody.replace('{n}', String(pages.length)).replace('{states}', String(evidence.pages.length)).replace('{commit}', evidence.baselineCommit.slice(0, 7)).replace('{date}', evidence.baselineDate.slice(0, 10)).replace('{open}', String(openGated))}</p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {pages.map((p) => (
                  <li key={p} className="rounded border border-amber-300 dark:border-amber-700 px-1.5 py-0.5 font-mono text-xs">{p}</li>
                ))}
              </ul>
              <p className="mt-2 text-xs">{v.tagsLabel}: <span className="font-mono">{evidence.tags.join(', ')}</span> · {v.gateLabel}: <span className="font-mono">{evidence.gatedSeverities.join(', ')}</span></p>
            </div>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{v.summaryTitle}</h2>
            <ul className="flex flex-wrap gap-2 text-sm" data-testid="vpat-summary">
              {CONFORMANCE_LEVELS.map((level) => (
                <li key={level} className={`rounded border px-2 py-1 ${TONE[level]}`}>
                  <span className="font-semibold">{summary[level]}</span> · {level}
                </li>
              ))}
            </ul>
            <p className="text-xs text-gray-500 dark:text-gray-400">{v.summaryNote}</p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{v.termsTitle}</h2>
            <dl className="grid gap-2 sm:grid-cols-2 text-sm">
              {CONFORMANCE_LEVELS.map((level) => (
                <div key={level}><dt className="font-medium text-gray-900 dark:text-gray-100">{level}</dt><dd className="text-gray-700 dark:text-gray-300">{doc.meta.terms[level]}</dd></div>
              ))}
            </dl>
          </section>

          <section className="space-y-6">
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{v.tables.wcag}</h2>
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{v.tables.wcagA}</h3>
              <RowsTable rows={a} columns={columns} withLevel={false} testId="vpat-table-wcag-a" />
            </div>
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{v.tables.wcagAA}</h3>
              <RowsTable rows={aa} columns={columns} withLevel={false} testId="vpat-table-wcag-aa" />
            </div>
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{v.tables.wcagAAA}</h3>
              <p className="text-xs text-gray-600 dark:text-gray-300">{doc.aaaNote}</p>
              <RowsTable rows={aaa} columns={columns} withLevel={false} testId="vpat-table-wcag-aaa" />
            </div>
          </section>

          <section className="space-y-6">
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{v.tables.s508}</h2>
            {doc.s508.map((s) => section('s508', s))}
          </section>

          <section className="space-y-6">
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{v.tables.en}</h2>
            {doc.en.map((s) => section('en', s, s.id === 'Chapter 9' ? doc.enChapter9 : []))}
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{v.evidenceTitle}</h2>
            <p className="text-sm text-gray-700 dark:text-gray-300">{v.evidenceIntro}</p>
            <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800">
              <table className="w-full text-xs" data-testid="vpat-evidence-table">
                <thead>
                  <tr className="bg-gray-50 dark:bg-gray-800/60 text-left text-gray-600 dark:text-gray-300">
                    <th scope="col" className="px-3 py-2 font-medium">{v.evidenceColumns.page}</th>
                    <th scope="col" className="px-3 py-2 font-medium">{v.evidenceColumns.theme}</th>
                    <th scope="col" className="px-3 py-2 font-medium">{v.evidenceColumns.result}</th>
                  </tr>
                </thead>
                <tbody>
                  {evidence.pages.map((p) => {
                    const open = Object.entries(p.violations);
                    return (
                      <tr key={p.key} className="border-t border-gray-100 dark:border-gray-800">
                        <td className="px-3 py-1.5 font-mono">{p.path}</td>
                        <td className="px-3 py-1.5">{p.theme}</td>
                        <td className="px-3 py-1.5">{open.length === 0 ? v.clean : open.map(([rule, n]) => `${rule}: ${n}`).join(', ')}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {v.generatedAt}: <span className="font-mono">{evidence.baselineCommit.slice(0, 7)}</span> · {evidence.baselineDate.slice(0, 10)} ·{' '}
              <a href={`${GITHUB_URL}/blob/main/docs/legal/vpat-evidence.md`} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline underline-offset-2">docs/legal/vpat-evidence.md</a>
            </p>
          </section>

          <p className="text-xs text-gray-500 dark:text-gray-400">{v.disclaimer}</p>
        </div>
      </div>
    </PublicShell>
  );
}
