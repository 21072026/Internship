// Renders the VPAT (src/lib/vpat.ts) and its evidence appendix as Markdown.
//
// PURE and import-free at runtime (type-only imports are erased), so the same
// function runs in three places: the `/accessibility/vpat.md` route, the page
// (which renders the structure itself but shares the cell formatting), and
// `scripts/vpat-evidence.mjs` under plain Node, which writes docs/legal/vpat.md.
// The unit test (scripts/test/vpat.test.mjs) re-renders from the committed
// data and fails when the committed Markdown differs — so the three never drift.
import type { Conformance, VpatRow, VpatSection } from './vpat';

/** One `<page>` or `<page>#dark` key of e2e/a11y-baseline.json. */
export interface VpatEvidencePage {
  key: string;
  path: string;
  theme: 'light' | 'dark';
  /** axe rule id → number of violating rules frozen into the baseline (0 = clean). */
  violations: Record<string, number>;
}

export interface VpatEvidence {
  /** The commit that last changed e2e/a11y-baseline.json, and its author date (ISO 8601). */
  baselineCommit: string;
  baselineDate: string;
  /** Short sha of HEAD when the appendix was generated. */
  generatedFrom: string;
  /** The axe tag set the gate runs (WCAG_TAGS in e2e/a11y-scan.spec.ts). */
  tags: string[];
  /** The severities that fail the build (GATED_SEVERITIES). */
  gatedSeverities: string[];
  pages: VpatEvidencePage[];
  /** The "Totals" line of docs/a11y-audit.md, or null when it could not be read. */
  totals: { critical: number; serious: number; moderate: number; minor: number } | null;
}

export interface VpatDocument {
  meta: {
    template: string;
    product: string;
    reportDate: string;
    versionNote: string;
    contactNote: string;
    notes: string;
    evaluationMethods: readonly string[];
    terms: Record<Conformance, string>;
  };
  /** Level A, AA and the evaluated AAA rows (in that order). */
  wcag: VpatRow[];
  aaaNote: string;
  /** EN 301 549 sections; chapter 9's generated rows are passed separately. */
  en: VpatSection[];
  enChapter9: VpatRow[];
  s508: VpatSection[];
  repoUrl: string;
  trackingIssue: number;
  selfAssessmentIssue: number;
  /** Where the appendix is published, relative to the report. */
  appendixHref: string;
}

/** A Markdown table cell: no pipes, no line breaks. */
export function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();
}

/** Repository path → blob link, issue → issue link, `check:` → verbatim. */
export function evidenceMarkdown(entry: string, repoUrl: string): string {
  const issue = /^#(\d+)$/.exec(entry);
  if (issue) return `[#${issue[1]}](${repoUrl}/issues/${issue[1]})`;
  if (entry.startsWith('check:')) return entry.replace(/^check:\s*/, 'check: ');
  const [path, line] = entry.split(/:(?=\d+$)/);
  const href = `${repoUrl}/blob/main/${path}${line ? `#L${line}` : ''}`;
  return `[\`${entry}\`](${href})`;
}

export function evidenceCell(evidence: readonly string[], repoUrl: string): string {
  if (evidence.length === 0) return '—';
  return evidence.map((e) => evidenceMarkdown(e, repoUrl)).join(' · ');
}

function rowsTable(rows: readonly VpatRow[], repoUrl: string, withLevel: boolean): string {
  const head = withLevel
    ? '| Criteria | Level | Conformance Level | Remarks and Explanations | Evidence |\n| --- | --- | --- | --- | --- |'
    : '| Criteria | Conformance Level | Remarks and Explanations | Evidence |\n| --- | --- | --- | --- |';
  const body = rows.map((r) => {
    const criteria = `**${r.id}** ${cell(r.name)}`;
    const cols = withLevel
      ? [criteria, r.level ?? '', r.conformance, cell(r.remarks), cell(evidenceCell(r.evidence, repoUrl))]
      : [criteria, r.conformance, cell(r.remarks), cell(evidenceCell(r.evidence, repoUrl))];
    return `| ${cols.join(' | ')} |`;
  });
  return [head, ...body].join('\n');
}

function sectionsMarkdown(sections: readonly VpatSection[], repoUrl: string, extra?: (s: VpatSection) => VpatRow[]): string {
  return sections
    .map((s) => {
      const rows = extra ? [...extra(s), ...s.rows] : s.rows;
      const parts = [`### ${s.id}: ${s.title}`];
      if (s.note) parts.push(s.note);
      parts.push(rowsTable(rows, repoUrl, false));
      return parts.join('\n\n');
    })
    .join('\n\n');
}

/** Count rows per conformance level — the figure the page shows above the tables. */
export function conformanceSummary(rows: readonly VpatRow[]): Record<Conformance, number> {
  const out: Record<Conformance, number> = { Supports: 0, 'Partially Supports': 0, 'Does Not Support': 0, 'Not Applicable': 0 };
  for (const r of rows) out[r.conformance] += 1;
  return out;
}

function pageStateLabel(p: VpatEvidencePage): string {
  return p.theme === 'dark' ? `${p.path} (dark)` : p.path;
}

/** The whole report, as published at docs/legal/vpat.md and /accessibility/vpat.md. */
export function renderVpat(doc: VpatDocument, evidence: VpatEvidence): string {
  const a = doc.wcag.filter((r) => r.level === 'A');
  const aa = doc.wcag.filter((r) => r.level === 'AA');
  const aaa = doc.wcag.filter((r) => r.level === 'AAA');
  const pageList = evidence.pages.filter((p) => p.theme === 'light').map((p) => `\`${p.path}\``).join(', ');
  const openGated = evidence.pages.reduce((n, p) => n + Object.values(p.violations).reduce((s, v) => s + v, 0), 0);
  const terms = (Object.keys(doc.meta.terms) as Conformance[]).map((k) => `- **${k}:** ${doc.meta.terms[k]}`).join('\n');

  return [
    `# InternshipCRM Accessibility Conformance Report`,
    ``,
    `## International Edition — ${doc.meta.template}`,
    ``,
    `<!-- GENERATED by scripts/vpat-evidence.mjs from src/lib/vpat.ts — do not edit by hand. Regenerate: npm run vpat:evidence -->`,
    ``,
    `**Name of Product/Version:** ${doc.meta.product}. ${doc.meta.versionNote}`,
    ``,
    `**Report Date:** ${doc.meta.reportDate}`,
    ``,
    `**Product Description:** A web application for running structured programmes between people and organisations — profiles, matching, a pipeline board, messaging, meetings, documents and reporting — served from a Next.js deployment and used in a browser on desktop and phone.`,
    ``,
    `**Contact Information:** ${doc.meta.contactNote}`,
    ``,
    `**Notes:** ${doc.meta.notes}`,
    ``,
    `**Evaluation Methods Used:**`,
    ``,
    ...doc.meta.evaluationMethods.map((m) => `- ${m}`),
    ``,
    `The evaluated URL set is exactly: ${pageList} — each in light and dark mode (${evidence.pages.length} page states), at commit \`${evidence.baselineCommit.slice(0, 7)}\` (${evidence.baselineDate.slice(0, 10)}), rule set \`${evidence.tags.join(', ')}\`, with ${openGated} open critical/serious finding(s) frozen in the baseline. **Every other URL of the product is pending evaluation.** The per-page result is in the [evidence appendix](${doc.appendixHref}).`,
    ``,
    `## Applicable Standards/Guidelines`,
    ``,
    `| Standard/Guideline | Included In Report |`,
    `| --- | --- |`,
    `| Web Content Accessibility Guidelines 2.2 | Level A: Yes · Level AA: Yes · Level AAA: Partially (Table 3 lists the criteria evaluated; the rest are Not Evaluated) |`,
    `| Revised Section 508 standards published January 18, 2017 and corrected January 22, 2018 | Yes |`,
    `| EN 301 549 Accessibility requirements for ICT products and services, V3.2.1 (2021-03) | Yes |`,
    ``,
    `## Terms`,
    ``,
    `The terms used in the Conformance Level information are defined as follows:`,
    ``,
    terms,
    ``,
    `Every row carries an **Evidence** column: the file in this repository whose behaviour the remark describes, the test that pins it, or the issue that tracks the gap. A row says *Supports* only when that column is not empty — that rule is enforced by \`scripts/test/vpat.test.mjs\`. Rows that cite [#${doc.trackingIssue}](${doc.repoUrl}/issues/${doc.trackingIssue}) are the ones a manual test programme or a fix would move; the self-assessment story is [#${doc.selfAssessmentIssue}](${doc.repoUrl}/issues/${doc.selfAssessmentIssue}).`,
    ``,
    `## WCAG 2.2 Report`,
    ``,
    `Tables 1 and 2 also document conformance with EN 301 549 clauses 9.1–9.4 (web content, WCAG 2.1 by reference; the clause-9 table below is generated from them) and with Revised Section 508 chapter 5 (501.1, WCAG 2.0 AA by reference).`,
    ``,
    `### Table 1: Success Criteria, Level A`,
    ``,
    rowsTable(a, doc.repoUrl, false),
    ``,
    `### Table 2: Success Criteria, Level AA`,
    ``,
    rowsTable(aa, doc.repoUrl, false),
    ``,
    `### Table 3: Success Criteria, Level AAA`,
    ``,
    doc.aaaNote,
    ``,
    rowsTable(aaa, doc.repoUrl, false),
    ``,
    `## Revised Section 508 Report`,
    ``,
    sectionsMarkdown(doc.s508, doc.repoUrl),
    ``,
    `## EN 301 549 Report`,
    ``,
    sectionsMarkdown(doc.en, doc.repoUrl, (s) => (s.id === 'Chapter 9' ? doc.enChapter9 : [])),
    ``,
    `## Legal Disclaimer`,
    ``,
    `This document is a self-assessment prepared by the maintainers from the evidence linked in it; it is provided for information and is not a warranty. The product is published under the AGPL-3.0-or-later licence and run by independent operators, each of whom publishes their own accessibility statement and contact; the rows above describe the software as shipped, not any one deployment's configuration or content. Report rows change when the evidence does — the regeneration rule is in \`docs/legal/README.md\`.`,
    ``,
  ].join('\n');
}

/** The generated appendix: which pages, which themes, which rule set, which result, at which commit. */
export function renderEvidenceAppendix(evidence: VpatEvidence, repoUrl: string): string {
  const rows = evidence.pages.map((p) => {
    const open = Object.entries(p.violations);
    const result = open.length === 0 ? 'clean' : open.map(([rule, n]) => `${rule}: ${n}`).join(', ');
    return `| \`${pageStateLabel(p)}\` | ${p.theme} | ${result} |`;
  });
  const totals = evidence.totals
    ? `critical: ${evidence.totals.critical} · serious: ${evidence.totals.serious} · moderate: ${evidence.totals.moderate} · minor: ${evidence.totals.minor}`
    : '(docs/a11y-audit.md could not be read)';
  const blob = `${repoUrl}/blob/${evidence.baselineCommit}`;
  return [
    `# VPAT evidence appendix`,
    ``,
    `<!-- GENERATED by scripts/vpat-evidence.mjs — do not edit by hand. Regenerate: npm run vpat:evidence -->`,
    ``,
    `The automated half of the evidence behind [docs/legal/vpat.md](vpat.md): what the accessibility gate scans and what it found. Read from [\`e2e/a11y-baseline.json\`](${blob}/e2e/a11y-baseline.json) as last changed in commit \`${evidence.baselineCommit.slice(0, 7)}\` on ${evidence.baselineDate.slice(0, 10)}, from \`docs/a11y-audit.md\` and from the gate's configuration in \`e2e/a11y-scan.spec.ts\`; generated at commit \`${evidence.generatedFrom}\`.`,
    ``,
    `## Rule set and gate`,
    ``,
    `- axe-core tags: ${evidence.tags.map((t) => `\`${t}\``).join(', ')}`,
    `- Severities that fail a pull request: ${evidence.gatedSeverities.map((t) => `\`${t}\``).join(', ')} (moderate and minor findings are reported in \`docs/a11y-audit.md\` but never gate)`,
    `- Report totals at the last regenerate: ${totals}`,
    ``,
    `## Page states scanned (${evidence.pages.length})`,
    ``,
    `A page is scanned once per theme; \`:param\` segments are route patterns the scan fills with a seeded record. "clean" means no critical or serious violation is frozen in the baseline for that page state; anything else lists the frozen rule ids and counts, which the gate tolerates until they are fixed.`,
    ``,
    `| Page state | Theme | Frozen critical/serious findings |`,
    `| --- | --- | --- |`,
    ...rows,
    ``,
    `## How to regenerate`,
    ``,
    '```bash',
    `A11Y_UPDATE_BASELINE=1 npx playwright test e2e/a11y-scan.spec.ts   # re-measure (needs a database)`,
    `npm run vpat:evidence                                             # rewrite this appendix and docs/legal/vpat.md`,
    `npm run test:unit -- scripts/test/vpat.test.mjs                   # the drift and "Supports needs evidence" checks`,
    '```',
    ``,
    `Whenever \`e2e/a11y-baseline.json\` changes, the regenerate above runs in the same pull request and the affected VPAT rows are re-reviewed (\`docs/legal/README.md\`).`,
    ``,
  ].join('\n');
}
