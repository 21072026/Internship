// The VPAT's shape rules (#2037).
// Run: node --test --experimental-strip-types scripts/test/vpat.test.mjs
//
// Two things a reviewer cannot keep in their head are enforced here: no row says
// `Supports` without an evidence path that exists, and the committed Markdown
// is exactly what the data renders (so src/lib/vpat.ts, docs/legal/vpat.md and
// the page can never disagree). The honesty of a remark is still a human's job.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  CONFORMANCE_LEVELS,
  EN_SECTIONS,
  S508_SECTIONS,
  VPAT_META,
  VPAT_SELF_ASSESSMENT_ISSUE,
  VPAT_TRACKING_ISSUE,
  WCAG_AAA_NOTE,
  WCAG_ROWS,
  enChapter9Rows,
  evidencePath,
} from '../../src/lib/vpat.ts';
import { renderEvidenceAppendix, renderVpat } from '../../src/lib/vpatRender.ts';
import { VPAT_EVIDENCE } from '../../src/lib/vpatEvidence.generated.ts';

const REPO_URL = 'https://github.com/21072026/Internship';
const allRows = [...WCAG_ROWS, ...EN_SECTIONS.flatMap((s) => s.rows), ...S508_SECTIONS.flatMap((s) => s.rows)];

// WCAG 2.2, Levels A and AA, in full — 4.1.1 included (reported as Not Applicable).
const WCAG_A = ['1.1.1', '1.2.1', '1.2.2', '1.2.3', '1.3.1', '1.3.2', '1.3.3', '1.4.1', '1.4.2', '2.1.1', '2.1.2', '2.1.4', '2.2.1', '2.2.2', '2.3.1', '2.4.1', '2.4.2', '2.4.3', '2.4.4', '2.5.1', '2.5.2', '2.5.3', '2.5.4', '3.1.1', '3.2.1', '3.2.2', '3.2.6', '3.3.1', '3.3.2', '3.3.7', '4.1.1', '4.1.2'];
const WCAG_AA = ['1.2.4', '1.2.5', '1.3.4', '1.3.5', '1.4.3', '1.4.4', '1.4.5', '1.4.10', '1.4.11', '1.4.12', '1.4.13', '2.4.5', '2.4.6', '2.4.7', '2.4.11', '2.5.7', '2.5.8', '3.1.2', '3.2.3', '3.2.4', '3.3.3', '3.3.4', '3.3.8', '4.1.3'];

function document() {
  return {
    meta: VPAT_META,
    wcag: WCAG_ROWS,
    aaaNote: WCAG_AAA_NOTE,
    en: EN_SECTIONS,
    enChapter9: enChapter9Rows(),
    s508: S508_SECTIONS,
    repoUrl: REPO_URL,
    trackingIssue: VPAT_TRACKING_ISSUE,
    selfAssessmentIssue: VPAT_SELF_ASSESSMENT_ISSUE,
    appendixHref: 'vpat-evidence.md',
  };
}

test('every row has one of the four conformance levels', () => {
  for (const r of allRows) assert.ok(CONFORMANCE_LEVELS.includes(r.conformance), `${r.id}: ${r.conformance}`);
});

test('WCAG 2.2 Level A and AA are complete, each criterion exactly once', () => {
  const ids = (level) => WCAG_ROWS.filter((r) => r.level === level).map((r) => r.id);
  assert.deepEqual([...ids('A')].sort(), [...WCAG_A].sort());
  assert.deepEqual([...ids('AA')].sort(), [...WCAG_AA].sort());
  assert.equal(new Set(WCAG_ROWS.map((r) => r.id)).size, WCAG_ROWS.length);
  for (const r of WCAG_ROWS) assert.ok(r.since, `${r.id} needs a WCAG version`);
});

test('no row says Supports without an evidence path', () => {
  for (const r of allRows) {
    if (r.conformance !== 'Supports') continue;
    assert.ok(r.evidence.length > 0, `${r.id} ${r.name}: Supports with no evidence`);
  }
});

test('every evidence path exists in the tree; issues and checks are well-formed', () => {
  for (const r of allRows) {
    for (const e of r.evidence) {
      const path = evidencePath(e);
      if (path === null) {
        assert.ok(/^#\d+$/.test(e) || /^check:\s*\S/.test(e), `${r.id}: malformed evidence "${e}"`);
        continue;
      }
      assert.ok(existsSync(path), `${r.id}: evidence path does not exist: ${e}`);
    }
  }
});

test('a row that leans on the tracking issue is not claimed as Supports', () => {
  for (const r of allRows) {
    if (r.evidence.includes(`#${VPAT_TRACKING_ISSUE}`)) {
      assert.notEqual(r.conformance, 'Supports', `${r.id} cites #${VPAT_TRACKING_ISSUE} and says Supports`);
    }
  }
});

test('chapter 9 is generated from the WCAG 2.1 A/AA rows, never hand-written', () => {
  const nine = enChapter9Rows();
  assert.ok(nine.every((r) => r.id.startsWith('9.') && r.level !== 'AAA' && r.since !== '2.2'));
  assert.equal(nine.length, WCAG_ROWS.filter((r) => r.level !== 'AAA' && r.since !== '2.2').length);
  const hand = EN_SECTIONS.find((s) => s.id === 'Chapter 9').rows.map((r) => r.id);
  assert.deepEqual(hand, ['9.5', '9.6']);
});

test('the generated evidence matches the baseline and the scan configuration', () => {
  const baseline = JSON.parse(readFileSync('e2e/a11y-baseline.json', 'utf8'));
  assert.deepEqual(VPAT_EVIDENCE.pages.map((p) => p.key), Object.keys(baseline), 'run npm run vpat:evidence — the baseline changed');
  for (const p of VPAT_EVIDENCE.pages) assert.deepEqual(p.violations, baseline[p.key], `${p.key}: run npm run vpat:evidence`);
  const spec = readFileSync('e2e/a11y-scan.spec.ts', 'utf8');
  const tags = [...(/const WCAG_TAGS\s*=\s*\[([^\]]*)\]/.exec(spec)[1].matchAll(/'([^']+)'/g))].map((m) => m[1]);
  assert.deepEqual(VPAT_EVIDENCE.tags, tags, 'run npm run vpat:evidence — the tag set changed');
  assert.match(VPAT_EVIDENCE.baselineCommit, /^[0-9a-f]{40}$/);
});

test('the committed Markdown is exactly what the data renders (run npm run vpat:evidence after editing src/lib/vpat.ts)', () => {
  assert.equal(readFileSync('docs/legal/vpat.md', 'utf8'), renderVpat(document(), VPAT_EVIDENCE));
  assert.equal(readFileSync('docs/legal/vpat-evidence.md', 'utf8'), renderEvidenceAppendix(VPAT_EVIDENCE, REPO_URL));
});

test('the report names its scope and its tracking issue', () => {
  const md = renderVpat(document(), VPAT_EVIDENCE);
  assert.match(md, /Every other URL of the product is pending evaluation/);
  assert.match(md, new RegExp(`issues/${VPAT_TRACKING_ISSUE}`));
  assert.match(md, /Table 1: Success Criteria, Level A/);
  assert.match(md, /EN 301 549 Report/);
  assert.match(md, /Revised Section 508 Report/);
});
