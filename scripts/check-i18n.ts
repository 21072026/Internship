// CI guard for i18n dictionary integrity (EN/TR/DE). TypeScript already enforces
// key parity via the `Dict` type, so this is defense-in-depth that ALSO catches
// what the type can't: empty / whitespace-only translations, and reports any
// drift with a clear, actionable message. Run with Node's TS stripping:
//   node --experimental-strip-types scripts/check-i18n.ts
import { dictionaries } from '../src/i18n/dictionaries.ts';
import { overlayEntries, applyVerticalOverlay, PRODUCT_PLACEHOLDER } from '../src/i18n/verticalOverlays.ts';
import type { Locale } from '../src/i18n/config.ts';

type AnyRec = Record<string, unknown>;

function flatten(obj: AnyRec, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flatten(v as AnyRec, key));
    } else {
      out[key] = String(v);
    }
  }
  return out;
}

const locales = Object.keys(dictionaries);
const BASE = 'en';
const baseFlat = flatten(dictionaries[BASE as keyof typeof dictionaries] as AnyRec);
const baseKeys = Object.keys(baseFlat);
const baseKeySet = new Set(baseKeys);
const errors: string[] = [];

for (const loc of locales) {
  const flat = flatten(dictionaries[loc as keyof typeof dictionaries] as AnyRec);
  const keySet = new Set(Object.keys(flat));
  for (const k of baseKeys) if (!keySet.has(k)) errors.push(`[${loc}] missing key: ${k}`);
  for (const k of keySet) if (!baseKeySet.has(k)) errors.push(`[${loc}] extra key: ${k}`);
  for (const [k, v] of Object.entries(flat)) {
    if (v.trim() === '') errors.push(`[${loc}] empty value: ${k}`);
  }
}

// Vertical terminology overlays (#2354): every override must target a key that
// already exists in the base (a typo would be a silent no-op — TypeScript also
// catches this, but the guard states it independently), and INTERNSHIP must
// override nothing (its emptiness is the no-op guarantee for today's product).
for (const { vertical, locale, overlay } of overlayEntries()) {
  const overlayKeys = Object.keys(flatten(overlay as AnyRec));
  if (vertical === 'INTERNSHIP' && overlayKeys.length > 0) {
    errors.push(`[overlay ${vertical}/${locale}] INTERNSHIP must override nothing, found: ${overlayKeys.join(', ')}`);
  }
  const localeBaseKeys = new Set(Object.keys(flatten(dictionaries[locale as keyof typeof dictionaries] as AnyRec)));
  for (const k of overlayKeys) {
    if (!localeBaseKeys.has(k)) errors.push(`[overlay ${vertical}/${locale}] key not in base dictionary: ${k}`);
  }
}

// An overlay REPLACES a sentence the code interpolates, so it must carry the
// same {placeholders} as the base value: a dropped `{menteeName}` would print
// a sentence with a hole, an added one a literal "{x}" (#2558).
//
// One token is the overlay's own (#2936): `{product}` is filled by
// applyVerticalOverlay() itself while it merges, so the code that renders the
// string never sees it. An overlay may therefore carry it where the base does
// not; where the base has it, the overlay must keep it like any other.
const placeholderSet = (s: string, overlayOwn: string[] = []) =>
  [...new Set([...s.matchAll(/\{[a-zA-Z]+\}/g)].map((m) => m[0]))].filter((p) => !overlayOwn.includes(p)).sort().join(' ');
for (const { vertical, locale, overlay } of overlayEntries()) {
  const base = flatten(dictionaries[locale as keyof typeof dictionaries] as AnyRec);
  for (const [k, v] of Object.entries(flatten(overlay as AnyRec))) {
    const overlayOwn = base[k] !== undefined && base[k].includes(PRODUCT_PLACEHOLDER) ? [] : [PRODUCT_PLACEHOLDER];
    if (base[k] !== undefined && placeholderSet(base[k]) !== placeholderSet(v, overlayOwn)) {
      errors.push(`[overlay ${vertical}/${locale}] ${k} has placeholders {${placeholderSet(v)}} but the base has {${placeholderSet(base[k])}}`);
    }
  }
}

// ---------------------------------------------------------------------------
// MARKETING terminology leak ratchet (#2558, story #2394 KK-2).
//
// A MARKETING tenant must not read the internship product's words. This
// counts, per locale, the overlay-RESOLVED MARKETING values that still contain
// one, and pins the count. It is a RATCHET, not a to-do list: the literal
// below is the one number to move, and it may only go down —
//   • more leaks than the literal  → exit 1 (a new "mentor" string reached a
//     namespace MARKETING renders without an overlay entry);
//   • fewer leaks than the literal → exit 1 too, so whoever removed some
//     lowers the literal in the same diff and nobody can later spend the slack.
// `npm run check:i18n -- --leaks` (optionally `--leaks=tr`) lists the keys.
//
// What is NOT a leak, and therefore never counted:
//   • a {placeholder} — `{menteeName}` is an interpolation slot the reader
//     never sees;
//   • the ROLE ENUM spelled as an enum (MENTOR / MENTEE in capitals) — the
//     CSV import's role column accepts exactly those tokens, and #2558 keeps
//     the enum and renames only its labels;
//   • a namespace in LEAK_EXEMPT below, each with the reason MARKETING cannot
//     render it. Anything not listed there counts, including the landing's
//     internship-only sections — an exemption must be argued, not assumed.
const LEAK_WORDS: Record<string, RegExp> = {
  // "internal" is not the internship product.
  en: /mentor|mentee|intern(?!al)/i,
  // German "intern" means internal, and "Mentoring" is caught by /mentor/.
  de: /mentor|mentee|praktik|internship/i,
  tr: /mentor|mentör|mentee|staj|internship/i,
};

const LEAK_EXEMPT: Record<string, string> = {
  portal: 'The mentee portal shell: src/app/portal/layout.tsx redirects every org without the `mentorship` capability to /account.',
  portalInsights: 'Rendered only inside /portal (see `portal`).',
  mentorAnalytics: 'Read only by the mentor shell (src/app/mentor), whose layout sends a MARKETING MENTOR to /sales.',
  mentorImpact: 'The private impact card on /mentor only (src/app/mentor/page.tsx) — the mentor layout sends a MARKETING MENTOR to /sales, and getMentorImpact() returns null without the `mentorship` capability.',
  offers: 'Offer management — `/api/offers` refuses an org without the `placements` capability (requireCapability).',
  offersAdmin: 'The admin offer screen over the same `placements`-gated API.',
  offerEmail: 'Sent only by src/lib/offerNotify.ts, i.e. by the `placements`-gated offer API.',
  adminWeeklyReports: '/admin/weekly-reports (#1918) — gatePage closes it, and its API refuses (requireCapability), for an org without the `mentorship` capability.',
  migration: '/admin/migrate (#2073) — gatePage closes it, and POST /api/admin/migrate refuses (requireCapability), for an org without the `mentorship` capability.',
  adminInsights: '/admin/insights (#2046) — gatePage closes it, and its API refuses (requireCapability), for an org without the `mentorship` capability.',
  adminAvailability: '/admin/availability (#2005) — gatePage closes it for an org without the `mentorship` capability, and the editor reads these keys only when an admin has picked a mentor there.',
  mentorLimitsImport: 'Read only by MentorLimitsImport on /admin/mentors (#1808) — gatePage closes that page, and POST /api/admin/mentors/limits/import refuses (requireCapability), for an org without the `mentorship` capability. Its column names are the CSV contract and cannot be overlaid.',
  groupEvents: '/admin|/mentor|/portal/events (#1856) — gatePage closes the three pages, and every /api/events route refuses (requireCapability), for an org without the `mentorship` capability.',
  adminMatching: '/admin/matching (#1783) — gatePage closes it, and every /api/admin/matching route refuses (requireCapability), for an org without the `mentorship` capability.',
  billing: '/admin/billing (#1739) — gatePage closes it, and GET /api/org/billing refuses (requireCapability), for an org without `mentorship`: the active-pair meter and the price list are the internship product\'s (src/lib/plans.ts); MARKETING has its own (src/lib/marketingPlans.ts).',
  adminHealth: '/admin/health (#1902) — gatePage closes it, and its API refuses (requireCapability), for an org without the `mentorship` capability.',
  forecastCapacity: 'The capacity half of the forecast panel (#1897) — /api/admin/analytics/forecast returns `capacity: null` for an org without the `mentorship` capability, and the executive page renders these strings only when it is present.',
  evaluationDue: 'Sent only by src/lib/evaluationDue.ts, whose sweep skips every org without the `evaluations` capability — a MARKETING tenant is never reminded of an evaluation (#1891).',
  signup: '/signup (#1751) — requireVerticalCapability(\'mentorship\') answers 404 on a vertical without the module, and POST /api/public/signup/org refuses a MARKETING host (invitation-only, #2501).',
  firstRun: 'The /admin first-run panel (#1751) — FirstRunPanel renders only when the org has the `mentorship` capability (shellCapabilities); a MARKETING admin never sees it.',
  productTour: 'The internship landing\'s product tour (#1399): ProductTour reads it only for an INTERNSHIP host, and its screenshots show the internship product. The MARKETING tour reads `productTourMarketing`, which is deliberately not exempt.',
  // Internship-only surfaces a MARKETING org cannot reach (the bulk overlay pass).
  activityReport: '/admin/mentee-activity — gatePage closes it for an org without the `mentorship` capability; the only other reader, /mentor/mentee-activity (ActivityReportView\'s second mount), is in the mentor shell, whose layout sends a MARKETING MENTOR to /sales.',
  apply: '/apply/[mentorId] (#2544) — src/app/apply/layout.tsx answers 404 through requireVerticalCapability(\'mentorship\'), and POST /api/apply refuses (requireCapability) for a mentor\'s org without `mentorship`. (MarketingAccountImport\'s `m.apply` is a different namespace.)',
  applyLink: 'Read only by ApplyLinkBox, which is mounted only on /mentor/mentees — the mentor layout sends a MARKETING MENTOR to /sales.',
  applyMentor: '/apply-as-mentor (#2544) — requireVerticalCapability(\'mentorship\') answers 404 on a vertical without the module, POST /api/mentor-applications refuses the same; the other reader, /admin/mentor-applications/[id], is closed by gatePage.',
  codeOfConduct: '/code-of-conduct — requireVerticalCapability(\'mentorship\') answers 404 on a vertical without the module, and PublicFooter drops the link on the marketing hosts (isMarketing).',
  participantJourney: 'Read only by JourneyView (#1855), mounted on /portal/journey (the portal layout sends an org without `mentorship` to /account) and /mentor/mentees/[id] (the mentor layout sends a MARKETING MENTOR to /sales); GET /api/journey refuses (requireCapability).',
  programJourney: '/admin/programs/[id]/journey (#1853) — its layout\'s gatePage closes it, and every /api/admin/programs/[id]/journey route refuses (requireCapability), for an org without `mentorship`.',
  agreementCard: 'Read only by AgreementCard and the /admin/mentorship agreement column (#1792), both rendered only from the `agreement` data GET /api/mentorship[/id] sends — and it sends it only for an org with the `mentorship` capability.',
  agreementsAdmin: '/admin/agreements (#1790) — gatePage closes it (its nav link carries `mentorship`), and /api/admin/agreements refuses (requireCapability), for an org without `mentorship`.',
  cohorts: '/admin/cohorts — gatePage closes it, and /api/cohorts refuses (requireCapability), for an org without `mentorship`; /admin/candidates/[id] only reads `d.cohorts` from that API\'s JSON, never the namespace.',
  dormantCheckIn: 'Sent only by sendDormantCheckIns (src/services/emailService.ts), whose sweep skips every org without `mentorship` (dormantCheckInApplies, src/lib/salesSurface.ts, #2970) before anything is claimed — a MARKETING lead is never mailed.',
  emailTemplates: 'Read by TargetedEmailComposer, mounted only on /admin/email (gatePage, `mentorship`) and /mentor/email (mentor shell), and by emitOutcomeComms (src/lib/outcomeComms.server.ts), which returns before the auto-send for an org without `placements`.',
  mentorApplicationEmail: 'Sent only by sendMentorApplication*Email (src/services/emailService.ts), called only from POST /api/mentor-applications (404 unless the request vertical carries `mentorship`) and PATCH /api/mentor-applications/[id] (requireCapability `mentorship`).',
  mentorApplications: 'Read only by /mentor/applications — the mentor layout sends a MARKETING MENTOR to /sales.',
  mentorApplicationsAdmin: '/admin/mentor-applications — gatePage closes it, and its APIs refuse (requireCapability), for an org without `mentorship`; AdminNav\'s pending badge hangs on the `mentorship`-tagged link, which visibleNavLinks() drops for MARKETING.',
  mentorDetail: '/admin/mentors/[id] — the /admin/mentors segment layout\'s gatePage closes it for an org without `mentorship`.',
  mentorEmail: 'Read only by TargetedEmailComposer, mounted only on /admin/email (gatePage, `mentorship`) and /mentor/email (mentor shell, which sends a MARKETING MENTOR to /sales).',
  mentorFeedback: 'Read only by /mentor/feedback — the mentor layout sends a MARKETING MENTOR to /sales.',
  mentors: '/admin/mentors — gatePage closes it for an org without `mentorship`; the other reader, MentorshipRequestPanel, is mounted only in /portal, whose layout redirects such an org.',
  mentorshipRequests: 'Read only by MentorshipRequestQueue (/admin/mentorship, gatePage) and MentorshipRequestPanel (/portal only, whose layout redirects an org without `mentorship`); the request APIs refuse (requireCapability).',
  relationLifecycle: 'Read only by RelationLifecycleControls (#1770), mounted on /admin/mentorship (gatePage, `mentorship`) and /mentor/mentees/[id] — the mentor layout sends a MARKETING MENTOR to /sales.',
  relationNotes: 'Read only by RelationNotesPanel, mounted only on /mentor/mentees/[id] — the mentor layout sends a MARKETING MENTOR to /sales.',
  rematchRequest: 'Read only by /admin/mentorship and its MentorshipRequestQueue (gatePage) and by MentorshipRequestPanel (/portal only, whose layout redirects an org without `mentorship`); /api/mentorship/[id]/rematch refuses (requireCapability).',
  sources: '/admin/sources — gatePage closes it for an org without the `sourcing` capability (MARKETING lacks it); the other files only read `d.sources` from API JSON, never the namespace.',
};

// The pinned counts. Lower them when a change removes leaks; never raise them
// — a new leak is fixed with an overlay entry (src/i18n/verticalOverlays.ts),
// or argued into LEAK_EXEMPT with its reason. History: 528/530/526 (en/tr/de)
// on the day the ratchet landed, before #2557/#2558's own overlay entries.
const EXPECTED_LEAKS: Record<string, number> = { en: 0, tr: 0, de: 0 };

const leakArg = process.argv.find((a) => a === '--leaks' || a.startsWith('--leaks='));
const listLocale = leakArg ? (leakArg.split('=')[1] ?? 'all') : null;

for (const loc of locales) {
  const resolved = flatten(
    applyVerticalOverlay(dictionaries[loc as keyof typeof dictionaries] as AnyRec, loc as Locale, 'MARKETING') as AnyRec,
  );
  const leaks = Object.entries(resolved).filter(([k, v]) => {
    if (LEAK_EXEMPT[k.split('.')[0]]) return false;
    const visible = v.replace(/\{[a-zA-Z]+\}/g, '').replace(/\bMENT(?:OR|EE)S?\b/g, '');
    return LEAK_WORDS[loc].test(visible);
  });
  if (listLocale === 'all' || listLocale === loc) {
    for (const [k, v] of leaks) console.log(`[leak ${loc}] ${k}: ${v}`);
  }
  const expected = EXPECTED_LEAKS[loc];
  if (leaks.length > expected) {
    errors.push(
      `[leak ${loc}] ${leaks.length} MARKETING-visible values contain internship words, the ratchet allows ${expected}. ` +
        `Add a MARKETING overlay entry for the new string (src/i18n/verticalOverlays.ts); run with --leaks=${loc} to list them.`,
    );
  } else if (leaks.length < expected) {
    errors.push(
      `[leak ${loc}] only ${leaks.length} leaks left, the ratchet still allows ${expected} — lower EXPECTED_LEAKS.${loc} in scripts/check-i18n.ts to ${leaks.length} in this diff.`,
    );
  }
}

if (errors.length > 0) {
  console.error(`i18n check FAILED — ${errors.length} issue(s):`);
  for (const e of errors) console.error('  ' + e);
  process.exit(1);
}

console.log(`i18n OK — ${baseKeys.length} keys × ${locales.length} locales (${locales.join(', ')})`);
console.log(
  `MARKETING leak ratchet at ${locales.map((l) => `${l} ${EXPECTED_LEAKS[l]}`).join(' · ')} (#2558; --leaks to list)`,
);
