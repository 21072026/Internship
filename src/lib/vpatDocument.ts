// The assembled VPAT document for the app's own renderers (#2037): the page and
// the Markdown route. The Node script (scripts/vpat-evidence.mjs) assembles the
// same shape itself, because it cannot resolve `@/` imports — keep the two in
// step (scripts/test/vpat.test.mjs renders through the script's shape and
// compares with the committed Markdown).
import { GITHUB_URL } from '@/components/landing/links';
import {
  EN_SECTIONS,
  S508_SECTIONS,
  VPAT_META,
  VPAT_SELF_ASSESSMENT_ISSUE,
  VPAT_TRACKING_ISSUE,
  WCAG_AAA_NOTE,
  WCAG_ROWS,
  enChapter9Rows,
} from '@/lib/vpat';
import type { VpatDocument } from '@/lib/vpatRender';

export function vpatDocument(): VpatDocument {
  return {
    meta: VPAT_META,
    wcag: WCAG_ROWS,
    aaaNote: WCAG_AAA_NOTE,
    en: EN_SECTIONS,
    enChapter9: enChapter9Rows(),
    s508: S508_SECTIONS,
    repoUrl: GITHUB_URL,
    trackingIssue: VPAT_TRACKING_ISSUE,
    selfAssessmentIssue: VPAT_SELF_ASSESSMENT_ISSUE,
    appendixHref: `${GITHUB_URL}/blob/main/docs/legal/vpat-evidence.md`,
  };
}
