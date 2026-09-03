/**
 * The public accessibility conformance statement (#2035).
 *
 * The prose lives in the `accessibility` i18n namespace; the *facts* live here,
 * because they are not translatable and because a claim that cannot be checked
 * against this repository has no business on that page. Every evidence row
 * carries the file or workflow that makes it true, and every known limitation
 * carries the issue that owns it — so a reader can verify the statement instead
 * of taking it on trust, and so a reviewer notices when a row goes stale.
 *
 * The canonical, longer version of the same statement (with the full method and
 * the review rule) is docs/accessibility-statement.md.
 */

import { GITHUB_URL } from '@/components/landing/links';

/**
 * When a human last read this statement against the evidence.
 *
 * Re-review rule (also written down in docs/accessibility-statement.md): any
 * change that WIDENS `e2e/a11y-baseline.json` — new violations frozen in rather
 * than fixed, the warning at e2e/a11y-scan.spec.ts prints it — invalidates the
 * "no critical or serious violations" sentence below and this date with it.
 * Adding a page to the scan or closing one of the limitations does too.
 */
export const ACCESSIBILITY_STATEMENT_REVIEWED = '2026-09-02';

/** Working days we aim to answer an accessibility report within. */
export const ACCESSIBILITY_RESPONSE_DAYS = 5;

/** Repository-relative path → the file on the default branch. */
export function repoFileUrl(path: string): string {
  return `${GITHUB_URL}/blob/main/${path}`;
}

export function issueUrl(issue: number): string {
  return `${GITHUB_URL}/issues/${issue}`;
}

/**
 * The URLs the automated gate actually visits, each in light and dark
 * (e2e/a11y-baseline.json holds `<page>` and `<page>#dark` for all nine).
 * Printed on the page verbatim: "scope" that names no URLs is not a scope.
 */
export const ACCESSIBILITY_SCANNED_PAGES = [
  '/',
  '/auth/signin',
  '/accessibility',
  '/portal',
  '/portal/profile',
  '/mentor',
  '/mentor/mentees',
  '/admin',
  '/admin/candidates',
  '/company',
] as const;

/**
 * One row per "we do this" claim. `key` indexes `accessibility.evidence` in the
 * dictionary; `source` is what makes the claim checkable.
 */
export const ACCESSIBILITY_EVIDENCE = [
  { key: 'automatedScan', source: 'e2e/a11y-scan.spec.ts' },
  { key: 'blockingGate', source: '.github/workflows/e2e.yml' },
  { key: 'report', source: 'docs/a11y-audit.md' },
  { key: 'darkMode', source: 'e2e/a11y-scan.spec.ts' },
  { key: 'skipLink', source: 'src/app/layout.tsx' },
  { key: 'focusRing', source: 'src/app/globals.css' },
  { key: 'dialogs', source: 'src/components/ui/useModalFocus.ts' },
  { key: 'targetSize', source: 'src/components/ui/Button.tsx' },
  { key: 'dragAlternative', source: 'src/components/board/CardStageSelect.tsx' },
  { key: 'textSize', source: 'src/components/FontSizeControl.tsx' },
  { key: 'osPreferences', source: 'e2e/a11y-media-preferences.spec.ts' },
  { key: 'languages', source: 'scripts/check-i18n.ts' },
] as const;

export type AccessibilityEvidenceKey = (typeof ACCESSIBILITY_EVIDENCE)[number]['key'];

/**
 * What does not conform yet. This list is the reason the page is worth
 * publishing at all: a conformance statement with an empty limitations section
 * is a marketing claim, and e2e/accessibility-statement.spec.ts fails if this
 * array ever empties out.
 *
 * `issue: null` means the gap is known and named but not yet scheduled — which
 * is still more honest than leaving it off the page.
 */
export const ACCESSIBILITY_LIMITATIONS: { key: string; issue: number | null }[] = [
  // The language and theme selects in account settings have no programmatic
  // name (src/components/AccountSettings.tsx) — axe `select-name`, critical.
  { key: 'accountSelects', issue: 2041 },
  // Six surfaces outside the mentee portal have never been scanned.
  { key: 'unscannedSurfaces', issue: 2043 },
  // The scan's mentee has no MentorshipRelation, so every relation-dependent
  // component on the portal renders empty and is measured as clean.
  { key: 'thinFixture', issue: 1412 },
  // Self-assessment only: no external audit, no assistive-technology test
  // programme, no VPAT yet. Tracked by the parent story.
  { key: 'noManualAudit', issue: 2033 },
  // src/app/layout.tsx sets `lang` but never `dir`.
  { key: 'noRtl', issue: null },
  // Embedded third parties (the live chat on the home page, the video-call
  // room) are not ours to fix.
  { key: 'thirdParty', issue: null },
];
