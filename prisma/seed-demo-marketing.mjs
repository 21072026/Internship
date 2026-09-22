// The MARKETING half of the demo set (#2443, story #2398).
//
// WHY THIS EXISTS
//   prisma/seed-demo.mjs seeds ONE organization and never sets `vertical`, so
//   every demo row is an INTERNSHIP tenant. The shipped MARKETING_FUNNEL stage
//   preset (src/lib/programTemplates.ts, #2353) therefore had nothing behind
//   it: a marketing board, a funnel report and an aging report that render
//   perfectly with zero rows. This module adds the second tenant —
//   `vertical: 'MARKETING'`, its own stage rows, thirty German merchant
//   accounts spread across the funnel with back-dated stage history — so the
//   marketing screens can actually be looked at.
//
// WHAT A MARKETING FUNNEL RECORD IS (docs/marketing-vertical/pipeline-record.md)
//   account       = Company            (the merchant; no new table)
//   funnel record = MentorshipRelation (the only pipeline carrier in the tree)
//   owner         = relation.mentorId  (a User of the org; NOT a new role)
//   lead person   = relation.menteeId  (a User with role MENTEE)
//   stage         = relation.pipelineStatus, a key of the org's PipelineStage rows
//   history       = StatusChange rows, keyed on relationId
//
// WHY THE STAGE LIST IS COPIED HERE INSTEAD OF IMPORTED
//   The one writer of a stage set is `replaceStages()`/`provisionStagePreset()`
//   in src/lib/pipelineStages.ts, which reads the preset from
//   `defaultTemplateForVertical('MARKETING')`. Both are TypeScript under src/,
//   and this seeder cannot reach either: `node prisma/seed-demo.mjs` is run
//   verbatim by infra/server/demo-refresh.sh and infra/server/topic-deploy.sh
//   inside the runtime image, which is node:20-slim and copies only
//   `public/ .next/ node_modules/ package.json prisma/` — there is no `src/`
//   in it at all, and Node 20 has no `--experimental-strip-types`.
//
//   So MARKETING_DEMO_STAGES below is a PLAIN-ESM MIRROR of the preset, the
//   same arrangement CLAUDE.md records for prisma/skill-split.mjs ↔
//   src/lib/skills.ts. The mirror is not trusted to stay in step by good
//   intentions: scripts/test/marketing-demo-tenant.test.mjs loads the real
//   preset through `defaultTemplateForVertical()` and asserts this array equals
//   `templateStagePayload()` field for field. A slice that adds, renames or
//   reorders a marketing stage (the trial pair, #2413, is the worked example)
//   turns `npm run test:unit` red until it changes both — which is exactly the
//   rule for skill-split.mjs.
//
// IDEMPOTENCY
//   Same mechanism as the internship half: everything lives in the
//   `@demo.example.com` namespace and every write is preceded by a lookup. A
//   second `npm run seed:demo` creates nothing. The funnel record is guarded by
//   "this lead already has ANY relation → skip", which is also what keeps the
//   one-active-mentor invariant (#419, src/lib/activeMentorship.ts) true
//   without a second copy of it here: a demo lead is created by this file, has
//   exactly one owner, and can never gain a second one on a re-run.
//
//   This module writes NOTHING by itself — `prisma` is handed in, so the safe
//   target assertion (prisma/demoTarget.mjs) the caller already made is the
//   only door, and the data exports below can be unit-tested without a
//   database and without a single import.

export const MARKETING_ORG_SLUG = 'demo-marketing';
export const MARKETING_ORG_NAME = 'SaleVali Demo (Marketing)';

/**
 * MIRROR of `NO_LOGIN_PASSWORD` (src/lib/menteeAccount.ts) — a sentinel, never a
 * bcrypt hash, so `bcrypt.compare` can never match it. The lead people below are
 * CRM *records*, not logins: the marketing importer writes exactly this for the
 * rows it creates (src/lib/marketingImportStore.ts), `isPendingActivation()`
 * renders them as records, and thirty sign-in-able MENTEE accounts in a tenant
 * whose vertical has no mentee portal would be a demo of something that does not
 * exist. The tenant's admin and its three account owners DO sign in and carry
 * the usual shared demo password.
 *
 * Their addresses stay in the `@demo.example.com` namespace rather than moving
 * to `import.local`: the namespace is what makes this seeder idempotent, what
 * `sanitize-db`/`reset-demo` key off, and demo.example.com is itself a reserved
 * domain that cannot receive mail — so the "nowhere to mail a reset link"
 * property the stand-in domain buys is already there.
 *
 * Compared against the real constant by scripts/test/marketing-demo-tenant.test.mjs.
 */
export const LEAD_NO_LOGIN_PASSWORD = '!created-no-login';

// PRO, not FREE: the FREE tier's advisory limits are 25 users and 25 active
// relations (src/lib/orgPlans.ts) and this tenant deliberately holds more, so
// on FREE every marketing screen would open on an over-limit banner about the
// demo data itself. Not ENTERPRISE either — that grants WHITE_LABEL and
// SSO_SAML, which this tenant is not demonstrating.
export const MARKETING_ORG_PLAN = 'PRO';

/**
 * MIRROR of `templateStagePayload(defaultTemplateForVertical('MARKETING'), 'en').stages`.
 * Read the header before editing: the unit test compares the two.
 */
export const MARKETING_DEMO_STAGES = [
  { key: 'LEAD_NEW', label: 'New lead', order: 0, isTerminal: false, isOffPath: false, color: '#2563eb' },
  { key: 'LEAD_CONTACTED', label: 'Contacted', order: 1, isTerminal: false, isOffPath: false, color: '#0ea5e9' },
  { key: 'LEAD_QUALIFIED', label: 'Qualified', order: 2, isTerminal: false, isOffPath: false, color: '#8b5cf6' },
  { key: 'TRIAL_ACTIVE', label: 'Trial running', order: 3, isTerminal: false, isOffPath: false, color: '#06b6d4' },
  { key: 'TRIAL_EXPIRED', label: 'Trial expired', order: 4, isTerminal: false, isOffPath: false, color: '#eab308' },
  { key: 'DEAL_PROPOSAL', label: 'Proposal sent', order: 5, isTerminal: false, isOffPath: false, color: '#f59e0b' },
  { key: 'DEAL_NEGOTIATION', label: 'Negotiation', order: 6, isTerminal: false, isOffPath: false, color: '#f97316' },
  { key: 'DEAL_WON', label: 'Won', order: 7, isTerminal: true, isOffPath: false, color: '#16a34a' },
  { key: 'DEAL_LOST', label: 'Lost', order: 8, isTerminal: true, isOffPath: true, color: '#6b7280' },
];

/** The tenant's admin — the identity you sign in as to browse the marketing product. */
export const MARKETING_ADMIN = { local: 'admin.marketing', fullName: 'Marketing Admin Demo' };

/**
 * The owners. `mentorId` on a marketing record means "who owns this account",
 * so these are ordinary MENTOR-role users of the org — the vertical does not
 * carry the `mentorship` capability, so nothing ever shows them as mentors.
 */
export const MARKETING_DEMO_OWNERS = [
  { local: 'owner.lena', fullName: 'Lena Demo (Account Manager)' },
  { local: 'owner.tarik', fullName: 'Tarık Demo (Account Manager)' },
  { local: 'owner.jonas', fullName: 'Jonas Demo (Account Manager)' },
];

/**
 * Thirty German merchant accounts, spread across every stage of the funnel.
 *
 *   stage       — where the record sits today (a key of MARKETING_DEMO_STAGES)
 *   openedAt    — days ago the record entered the funnel at LEAD_NEW
 *   inStage     — days ago it entered its CURRENT stage; the intermediate moves
 *                 are spread evenly between the two, so the aging report and the
 *                 cohort curves get a spread instead of one cliff
 *   droppedFrom — for a lost deal: the stage it fell out of (its history runs
 *                 LEAD_NEW … droppedFrom → DEAL_LOST)
 *   owner       — index into MARKETING_DEMO_OWNERS
 *   trialDays   — length of the contractual trial window, for the two trial stages
 *
 * Everything is synthetic: the names are invented, the VAT numbers sit in an
 * unassigned DE9xxxxxxxx range and every address is a mailbox on
 * demo.example.com, an IANA-reserved domain that cannot receive mail.
 */
export const MARKETING_DEMO_ACCOUNTS = [
  // ── New leads ──────────────────────────────────────────────────────────────
  { key: 'weber-keramik', name: 'Weber Keramik Manufaktur GmbH (Demo)', vatId: 'DE900000001', city: 'Kassel', industry: 'E-Commerce · Haus & Garten', size: '10-50', contactName: 'Jonas Weber', stage: 'LEAD_NEW', openedAt: 3, inStage: 3, owner: 0 },
  { key: 'nordlicht-outdoor', name: 'Nordlicht Outdoor Handel GmbH (Demo)', vatId: 'DE900000002', city: 'Kiel', industry: 'E-Commerce · Sport', size: '10-50', contactName: 'Marit Hansen', stage: 'LEAD_NEW', openedAt: 5, inStage: 5, owner: 1 },
  { key: 'bergmann-werkzeuge', name: 'Bergmann Werkzeuge e.K. (Demo)', vatId: 'DE900000003', city: 'Solingen', industry: 'B2B · Werkzeug', size: '1-10', contactName: 'Ralf Bergmann', stage: 'LEAD_NEW', openedAt: 7, inStage: 7, owner: 2 },
  { key: 'suedwind-gewuerze', name: 'Südwind Gewürzkontor GmbH (Demo)', vatId: 'DE900000004', city: 'Stuttgart', industry: 'E-Commerce · Lebensmittel', size: '10-50', contactName: 'Aylin Yıldız', stage: 'LEAD_NEW', openedAt: 9, inStage: 9, owner: 0 },
  { key: 'papierhaus-lenz', name: 'Papierhaus Lenz OHG (Demo)', vatId: 'DE900000005', city: 'Leipzig', industry: 'Einzelhandel · Papeterie', size: '1-10', contactName: 'Sabine Lenz', stage: 'LEAD_NEW', openedAt: 12, inStage: 12, owner: 1 },

  // ── Contacted ──────────────────────────────────────────────────────────────
  { key: 'hanse-fahrrad', name: 'Hanse Fahrradteile GmbH (Demo)', vatId: 'DE900000006', city: 'Hamburg', industry: 'E-Commerce · Fahrrad', size: '50-100', contactName: 'Tim Petersen', stage: 'LEAD_CONTACTED', openedAt: 16, inStage: 4, owner: 2 },
  { key: 'rheinland-elektro', name: 'Rheinland Elektrobedarf GmbH (Demo)', vatId: 'DE900000007', city: 'Köln', industry: 'B2B · Elektro', size: '50-100', contactName: 'Maria Klein', stage: 'LEAD_CONTACTED', openedAt: 19, inStage: 6, owner: 0 },
  { key: 'alpen-textil', name: 'Alpen Textilvertrieb GmbH (Demo)', vatId: 'DE900000008', city: 'München', industry: 'E-Commerce · Mode', size: '10-50', contactName: 'Korbinian Huber', stage: 'LEAD_CONTACTED', openedAt: 22, inStage: 9, owner: 1 },
  { key: 'spree-spielwaren', name: 'Spree Spielwaren GmbH (Demo)', vatId: 'DE900000009', city: 'Berlin', industry: 'E-Commerce · Spielzeug', size: '10-50', contactName: 'Nele Brandt', stage: 'LEAD_CONTACTED', openedAt: 25, inStage: 11, owner: 2 },
  { key: 'ostfriesen-tee', name: 'Ostfriesen Teekontor e.K. (Demo)', vatId: 'DE900000010', city: 'Emden', industry: 'E-Commerce · Lebensmittel', size: '1-10', contactName: 'Hauke Janssen', stage: 'LEAD_CONTACTED', openedAt: 28, inStage: 14, owner: 0 },

  // ── Qualified ──────────────────────────────────────────────────────────────
  { key: 'moebel-rothe', name: 'Möbelwerk Rothe GmbH (Demo)', vatId: 'DE900000011', city: 'Chemnitz', industry: 'E-Commerce · Möbel', size: '50-100', contactName: 'Katrin Rothe', stage: 'LEAD_QUALIFIED', openedAt: 34, inStage: 8, owner: 1 },
  { key: 'taunus-tierbedarf', name: 'Taunus Tierbedarf GmbH (Demo)', vatId: 'DE900000012', city: 'Frankfurt am Main', industry: 'E-Commerce · Tierbedarf', size: '10-50', contactName: 'Oliver Dietz', stage: 'LEAD_QUALIFIED', openedAt: 38, inStage: 12, owner: 2 },
  { key: 'lausitz-glas', name: 'Lausitzer Glashandel GmbH (Demo)', vatId: 'DE900000013', city: 'Cottbus', industry: 'B2B · Glas', size: '10-50', contactName: 'Ines Kowalski', stage: 'LEAD_QUALIFIED', openedAt: 41, inStage: 17, owner: 0 },
  { key: 'schwarzwald-uhren', name: 'Schwarzwald Uhrenkontor GmbH (Demo)', vatId: 'DE900000014', city: 'Freiburg', industry: 'E-Commerce · Schmuck & Uhren', size: '10-50', contactName: 'Bernd Faller', stage: 'LEAD_QUALIFIED', openedAt: 46, inStage: 21, owner: 1 },

  // ── Trial running ──────────────────────────────────────────────────────────
  { key: 'kiez-kaffee', name: 'Kiez Kaffeerösterei GmbH (Demo)', vatId: 'DE900000015', city: 'Berlin', industry: 'E-Commerce · Kaffee', size: '10-50', contactName: 'Lukas Ferber', stage: 'TRIAL_ACTIVE', openedAt: 52, inStage: 6, owner: 2, trialDays: 30 },
  { key: 'ruhr-baustoffe', name: 'Ruhr Baustoffhandel GmbH (Demo)', vatId: 'DE900000016', city: 'Essen', industry: 'B2B · Baustoffe', size: '100-250', contactName: 'Mehmet Aydın', stage: 'TRIAL_ACTIVE', openedAt: 57, inStage: 11, owner: 0, trialDays: 30 },
  { key: 'seestern-aquaristik', name: 'Seestern Aquaristik GmbH (Demo)', vatId: 'DE900000017', city: 'Rostock', industry: 'E-Commerce · Aquaristik', size: '10-50', contactName: 'Frauke Möller', stage: 'TRIAL_ACTIVE', openedAt: 61, inStage: 16, owner: 1, trialDays: 30 },
  { key: 'main-medizintechnik', name: 'Main Medizintechnik GmbH (Demo)', vatId: 'DE900000018', city: 'Würzburg', industry: 'B2B · Medizintechnik', size: '50-100', contactName: 'Anke Sommer', stage: 'TRIAL_ACTIVE', openedAt: 66, inStage: 21, owner: 2, trialDays: 45 },

  // ── Trial expired ──────────────────────────────────────────────────────────
  { key: 'harz-holzwerk', name: 'Harzer Holzwerk GmbH (Demo)', vatId: 'DE900000019', city: 'Goslar', industry: 'E-Commerce · Holz', size: '10-50', contactName: 'Stefan Wernicke', stage: 'TRIAL_EXPIRED', openedAt: 74, inStage: 4, owner: 0, trialDays: 30 },
  { key: 'donau-buerobedarf', name: 'Donau Bürobedarf GmbH (Demo)', vatId: 'DE900000020', city: 'Regensburg', industry: 'B2B · Bürobedarf', size: '50-100', contactName: 'Petra Vogl', stage: 'TRIAL_EXPIRED', openedAt: 81, inStage: 9, owner: 1, trialDays: 30 },

  // ── Proposal sent ──────────────────────────────────────────────────────────
  { key: 'elbland-weine', name: 'Elbland Weinhandel GmbH (Demo)', vatId: 'DE900000021', city: 'Dresden', industry: 'E-Commerce · Wein', size: '10-50', contactName: 'Konstantin Gräf', stage: 'DEAL_PROPOSAL', openedAt: 88, inStage: 5, owner: 2 },
  { key: 'westfalen-leuchten', name: 'Westfalen Leuchtenhandel GmbH (Demo)', vatId: 'DE900000022', city: 'Dortmund', industry: 'E-Commerce · Beleuchtung', size: '50-100', contactName: 'Britta Schulte', stage: 'DEAL_PROPOSAL', openedAt: 94, inStage: 10, owner: 0 },
  { key: 'allgaeu-milchhof', name: 'Allgäuer Milchhof Direkt GmbH (Demo)', vatId: 'DE900000023', city: 'Kempten', industry: 'E-Commerce · Lebensmittel', size: '50-100', contactName: 'Josef Wiedemann', stage: 'DEAL_PROPOSAL', openedAt: 99, inStage: 15, owner: 1 },

  // ── Negotiation ────────────────────────────────────────────────────────────
  { key: 'pfalz-pflanzen', name: 'Pfalz Pflanzenversand GmbH (Demo)', vatId: 'DE900000024', city: 'Landau', industry: 'E-Commerce · Garten', size: '50-100', contactName: 'Miriam Zeller', stage: 'DEAL_NEGOTIATION', openedAt: 106, inStage: 7, owner: 2 },
  { key: 'weser-sanitaer', name: 'Weser Sanitärhandel GmbH (Demo)', vatId: 'DE900000025', city: 'Bremen', industry: 'B2B · Sanitär', size: '100-250', contactName: 'Holger Ahrens', stage: 'DEAL_NEGOTIATION', openedAt: 113, inStage: 13, owner: 0 },

  // ── Won ────────────────────────────────────────────────────────────────────
  { key: 'bodensee-buecher', name: 'Bodensee Büchergilde GmbH (Demo)', vatId: 'DE900000026', city: 'Konstanz', industry: 'E-Commerce · Bücher', size: '10-50', contactName: 'Clara Bühler', stage: 'DEAL_WON', openedAt: 121, inStage: 9, owner: 1 },
  { key: 'saar-schrauben', name: 'Saar Schraubenwerk GmbH (Demo)', vatId: 'DE900000027', city: 'Saarbrücken', industry: 'B2B · Befestigungstechnik', size: '100-250', contactName: 'Dieter Marx', stage: 'DEAL_WON', openedAt: 134, inStage: 24, owner: 2 },
  { key: 'altmark-imkerei', name: 'Altmark Imkerei Handels GmbH (Demo)', vatId: 'DE900000028', city: 'Stendal', industry: 'E-Commerce · Lebensmittel', size: '1-10', contactName: 'Heike Ollrich', stage: 'DEAL_WON', openedAt: 148, inStage: 38, owner: 0 },

  // ── Lost ───────────────────────────────────────────────────────────────────
  { key: 'vogtland-modellbau', name: 'Vogtland Modellbau GmbH (Demo)', vatId: 'DE900000029', city: 'Plauen', industry: 'E-Commerce · Modellbau', size: '10-50', contactName: 'Uwe Seifert', stage: 'DEAL_LOST', openedAt: 128, inStage: 19, owner: 1, droppedFrom: 'DEAL_PROPOSAL', reasonCode: 'NO_RESPONSE' },
  { key: 'eifel-kaese', name: 'Eifel Käsekontor GmbH (Demo)', vatId: 'DE900000030', city: 'Bitburg', industry: 'E-Commerce · Lebensmittel', size: '10-50', contactName: 'Nadine Thelen', stage: 'DEAL_LOST', openedAt: 141, inStage: 31, owner: 2, droppedFrom: 'DEAL_NEGOTIATION', reasonCode: 'ACCEPTED_ELSEWHERE' },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days-ago → Date, anchored to UTC midnight so a second run writes the same instants. */
function daysAgo(days) {
  const midnightToday = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  return new Date(midnightToday - days * DAY_MS);
}

/**
 * The stage keys a record passed through, oldest first, ending on its current
 * stage. A lost deal runs through the on-path stages up to (and including)
 * `droppedFrom` and then falls off the path.
 *
 * Exported for the unit test: "every account's history is a real walk through
 * the preset" is the property that makes the aging and cohort curves mean
 * anything, and it is cheaper to assert here than against a database.
 */
export function stagePathFor(account, stages = MARKETING_DEMO_STAGES) {
  const onPath = stages.filter((s) => !s.isOffPath).map((s) => s.key);
  if (account.droppedFrom) {
    const until = onPath.indexOf(account.droppedFrom);
    if (until < 0) throw new Error(`${account.key}: droppedFrom "${account.droppedFrom}" is not an on-path stage`);
    return [...onPath.slice(0, until + 1), account.stage];
  }
  const until = onPath.indexOf(account.stage);
  if (until < 0) throw new Error(`${account.key}: stage "${account.stage}" is not an on-path stage of the preset`);
  return onPath.slice(0, until + 1);
}

/**
 * When each move in the path happened, as days-ago numbers: the record enters
 * at `openedAt`, sits in its current stage since `inStage`, and the moves in
 * between are spread evenly. Empty for a record still sitting on LEAD_NEW.
 */
export function transitionDaysFor(account, stages = MARKETING_DEMO_STAGES) {
  const path = stagePathFor(account, stages);
  const moves = path.length - 1;
  if (moves <= 0) return [];
  const span = account.openedAt - account.inStage;
  return Array.from({ length: moves }, (_, i) => Math.round(account.openedAt - (span * (i + 1)) / moves));
}

// What an owner writes down, per stage. Indexed rather than random: the seed
// stays deterministic, which is what makes a second run a no-op.
const INTERACTIONS_BY_STAGE = {
  LEAD_NEW: [{ type: 'Email', subject: 'First outreach', notes: 'Sent the intro e-mail with the pricing one-pager. (demo)' }],
  LEAD_CONTACTED: [
    { type: 'Email', subject: 'First outreach', notes: 'Sent the intro e-mail with the pricing one-pager. (demo)' },
    { type: 'Meeting', subject: 'Discovery call', notes: 'Fifteen minutes on how they list today and what breaks at volume. (demo)' },
  ],
  LEAD_QUALIFIED: [
    { type: 'Meeting', subject: 'Discovery call', notes: 'Fifteen minutes on how they list today and what breaks at volume. (demo)' },
    { type: 'Feedback', subject: 'Qualification', notes: 'Budget, channel mix and decision maker confirmed. (demo)' },
  ],
  TRIAL_ACTIVE: [
    { type: 'Feedback', subject: 'Qualification', notes: 'Budget, channel mix and decision maker confirmed. (demo)' },
    { type: 'Meeting', subject: 'Trial kick-off', notes: 'Walked the team through the import and the first report. (demo)' },
    { type: 'Email', subject: 'Trial check-in', notes: 'Asked how the first week went and offered a call. (demo)' },
  ],
  TRIAL_EXPIRED: [
    { type: 'Meeting', subject: 'Trial kick-off', notes: 'Walked the team through the import and the first report. (demo)' },
    { type: 'Email', subject: 'Trial ended', notes: 'Trial window closed; waiting on their decision. (demo)' },
  ],
  DEAL_PROPOSAL: [
    { type: 'Email', subject: 'Proposal sent', notes: 'Proposal with the two-tier pricing went out. (demo)' },
    { type: 'Meeting', subject: 'Proposal walkthrough', notes: 'Went through the proposal line by line. (demo)' },
  ],
  DEAL_NEGOTIATION: [
    { type: 'Email', subject: 'Proposal sent', notes: 'Proposal with the two-tier pricing went out. (demo)' },
    { type: 'Meeting', subject: 'Terms', notes: 'Talked through the term length and the onboarding fee. (demo)' },
    { type: 'Feedback', subject: 'Internal note', notes: 'Wants a three-month break clause; worth conceding. (demo)' },
  ],
  DEAL_WON: [
    { type: 'Meeting', subject: 'Terms', notes: 'Talked through the term length and the onboarding fee. (demo)' },
    { type: 'Email', subject: 'Signed', notes: 'Contract signed; onboarding scheduled. (demo)' },
  ],
  DEAL_LOST: [
    { type: 'Email', subject: 'Proposal sent', notes: 'Proposal with the two-tier pricing went out. (demo)' },
    { type: 'Feedback', subject: 'Closed lost', notes: 'No decision made; account parked for a later approach. (demo)' },
  ],
};

/**
 * Seed the MARKETING demo tenant. Writes nothing that is already there.
 *
 * @param {object} args
 * @param {import('@prisma/client').PrismaClient} args.prisma
 * @param {string} args.passwordHash  the bcrypt hash every demo account shares
 * @param {string} args.domain        the demo e-mail namespace (demo.example.com)
 * @param {(msg: string) => void} [args.log]
 */
export async function seedMarketingDemo({ prisma, passwordHash, domain, log = console.log }) {
  const org = await prisma.organization.upsert({
    where: { slug: MARKETING_ORG_SLUG },
    // `update` is deliberately not empty, unlike the default org's upsert: a
    // demo database seeded by an older version of this file may hold an org on
    // this slug that predates a change here, and a MARKETING tenant that reads
    // back as INTERNSHIP is the exact bug this task is about.
    update: { vertical: 'MARKETING', plan: MARKETING_ORG_PLAN },
    create: {
      slug: MARKETING_ORG_SLUG,
      name: MARKETING_ORG_NAME,
      vertical: 'MARKETING',
      plan: MARKETING_ORG_PLAN,
    },
    select: { id: true },
  });

  // The tenant's own stage rows. Upsert per key rather than the editor's
  // delete-then-create: a delete would strand every record sitting on the stage
  // (src/lib/programTemplates.ts, `stranded_relations`). A stage the preset no
  // longer names is left alone for the same reason — a demo seeder is not the
  // place to decide a live record's fate.
  for (const stage of MARKETING_DEMO_STAGES) {
    await prisma.pipelineStage.upsert({
      where: { orgId_key: { orgId: org.id, key: stage.key } },
      update: {
        label: stage.label,
        order: stage.order,
        isTerminal: stage.isTerminal,
        isOffPath: stage.isOffPath,
        color: stage.color,
      },
      create: { orgId: org.id, ...stage },
    });
  }

  const upsertUser = async ({ local, fullName, role, password = passwordHash, extra = {} }) => {
    const email = `${local}@${domain}`;
    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true, orgId: true } });
    if (existing) {
      // A demo row that predates this tenant — or that the org backfill in
      // seed-demo.mjs claimed for the default org — is moved here once.
      if (existing.orgId !== org.id) {
        await prisma.user.update({ where: { id: existing.id }, data: { orgId: org.id } });
      }
      return existing;
    }
    return prisma.user.create({
      data: {
        email,
        password,
        role,
        fullName,
        skills: [],
        orgId: org.id,
        // Only for the accounts that really sign in. A record with a sentinel
        // password has no mailbox to verify and is not pretending to have one.
        emailVerified: password === passwordHash,
        ...extra,
      },
      select: { id: true, orgId: true },
    });
  };

  await upsertUser({ ...MARKETING_ADMIN, role: 'ADMIN' });
  const owners = [];
  for (const owner of MARKETING_DEMO_OWNERS) {
    owners.push(await upsertUser({ ...owner, role: 'MENTOR' }));
  }

  let accountsCreated = 0;
  let recordsCreated = 0;
  let historyRows = 0;
  let interactionRows = 0;

  for (let index = 0; index < MARKETING_DEMO_ACCOUNTS.length; index++) {
    const account = MARKETING_DEMO_ACCOUNTS[index];
    const owner = owners[account.owner % owners.length];

    // Matched on VAT id inside the org — what the account importer matches on
    // first (docs/marketing-import.md) and what `@@unique([orgId, vatId])`
    // protects. findFirst + create rather than upsert: that compound unique
    // contains a nullable column, and a plain lookup needs no opinion about how
    // Prisma names such an input.
    let company = await prisma.company.findFirst({
      where: { orgId: org.id, vatId: account.vatId },
      select: { id: true },
    });
    if (!company) {
      company = await prisma.company.create({
        data: {
          orgId: org.id,
          name: account.name,
          vatId: account.vatId,
          country: 'DE',
          industry: account.industry,
          size: account.size,
          address: `${account.city}, Deutschland`,
          // The merchant's own mailbox — the "who do we call" columns (#2407).
          // A different address from the lead User below on purpose: the funnel
          // record's person is a CRM record, the account's contact is where a
          // human actually writes.
          contactName: account.contactName,
          contactEmail: `kontakt.${account.key}@${domain}`,
          contactPhone: `+49 30 5550 ${String(1000 + index).slice(-4)}`,
        },
        select: { id: true },
      });
      accountsCreated++;
    }

    // The lead person. `MentorshipRelation.menteeId` is a required FK, so a
    // funnel record cannot exist without one — see
    // docs/marketing-vertical/pipeline-record.md, "what an importer must do".
    const lead = await upsertUser({
      local: `lead.${account.key}`,
      fullName: `${account.contactName} (Demo)`,
      role: 'MENTEE',
      password: LEAD_NO_LOGIN_PASSWORD,
      extra: { companyId: company.id, city: account.city },
    });

    // One mentee, at most one ACTIVE mentor (#419) — no status filter, exactly
    // as the internship half does it: a lead that already carries ANY relation
    // is skipped whole, so a re-seed can never open a second record on it.
    const existing = await prisma.mentorshipRelation.findFirst({
      where: { menteeId: lead.id },
      select: { id: true },
    });
    if (existing) continue;

    const path = stagePathFor(account);
    const transitions = transitionDaysFor(account);
    // The contractual trial window (#2413) — NOT `stageDeadline`, which is the
    // internal service level. A running trial ends in the future, an expired
    // one ended when the record moved into TRIAL_EXPIRED.
    const trial = account.trialDays
      ? account.stage === 'TRIAL_ACTIVE'
        ? { trialStartedAt: daysAgo(account.inStage), trialEndsAt: daysAgo(account.inStage - account.trialDays) }
        : { trialStartedAt: daysAgo(account.inStage + account.trialDays), trialEndsAt: daysAgo(account.inStage) }
      : {};

    const relation = await prisma.mentorshipRelation.create({
      data: {
        orgId: org.id,
        mentorId: owner.id,
        menteeId: lead.id,
        companyId: company.id,
        pipelineStatus: account.stage,
        startDate: daysAgo(account.openedAt),
        ...trial,
      },
      select: { id: true },
    });
    recordsCreated++;

    // Back-dated history: one StatusChange per move, oldest first, so
    // stageAging/stageClock read a real time-in-stage instead of "moved just
    // now" and the cohort curves have months to group by.
    for (let move = 1; move < path.length; move++) {
      const isDropOut = path[move] === account.stage && Boolean(account.droppedFrom);
      await prisma.statusChange.create({
        data: {
          relationId: relation.id,
          fromStatus: path[move - 1],
          toStatus: path[move],
          changedById: owner.id,
          createdAt: daysAgo(transitions[move - 1]),
          // An off-path move carries a reason everywhere else in the product
          // (#810, src/lib/stageChange.ts); a demo that skipped it would teach
          // the drop-off report to expect nulls.
          ...(isDropOut ? { reasonCode: account.reasonCode ?? 'OTHER' } : {}),
        },
      });
      historyRows++;
    }

    // Interaction history, dated between the move that brought the record to
    // its current stage and today. The "last contact" rule (docs/last-contact.md)
    // reads these, so the spread is what gives the attention queue a mix of
    // fresh and neglected accounts.
    const logs = INTERACTIONS_BY_STAGE[account.stage] ?? [];
    const spread = Math.max(1, Math.round((account.openedAt - account.inStage) / (logs.length + 1)));
    for (let i = 0; i < logs.length; i++) {
      await prisma.interactionLog.create({
        data: {
          relationId: relation.id,
          type: logs[i].type,
          subject: logs[i].subject,
          notes: logs[i].notes,
          date: daysAgo(Math.max(0, account.inStage + spread * (logs.length - 1 - i))),
        },
      });
      interactionRows++;
    }
  }

  log(
    `marketing demo tenant (${MARKETING_ORG_SLUG}): ${MARKETING_DEMO_STAGES.length} stages, ` +
      `${accountsCreated} account(s), ${recordsCreated} funnel record(s), ` +
      `${historyRows} stage change(s), ${interactionRows} interaction(s) created`,
  );

  return { orgId: org.id, accountsCreated, recordsCreated, historyRows, interactionRows };
}
