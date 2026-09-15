// The vertical catalogue (#2350, epic #2348).
//
// coreCRM is ONE core serving several products. Which product a tenant is
// looking at is a property of the tenant — Organization.vertical — not of the
// deployment, so two organizations on the same container can be different
// products. This file is the catalogue that key resolves against.
//
// Pure data + helpers, no DB and no server imports, so it is safe from client
// components (the admin org screen imports it). Same shape as orgPlans.ts,
// deliberately: the plan catalogue is the worked example of "the DB stores the
// key, the code stores what the key MEANS", and a vertical is the same kind of
// thing — product packaging that should change with a deploy, not a migration.
//
// This slice ships the catalogue with NO readers: nothing branches on a
// vertical yet. Capabilities land in #2351, the stage preset in #2353 and the
// terminology overlay in #2354. `capabilities` is declared here now because a
// catalogue whose shape arrives later is a catalogue everyone works around in
// the meantime.
//
// What is deliberately NOT here is the per-vertical stage preset. It would be a
// key into PROGRAM_TEMPLATES (src/lib/programTemplates.ts) — a plain `string`
// pointer that nothing in this slice resolves, so a key that matches no template
// would type-check, pass every test, and only surface as an empty pipeline (or a
// 500) in the slice that finally reads it. That is exactly the failure mode
// CLAUDE.md records for the pipeline enum. The preset lands in #2353 together
// with the MARKETING template itself, where it has a reader and an e2e that
// proves the stages actually appear.

export type VerticalKey = 'INTERNSHIP' | 'MARKETING';

// What a vertical may switch off. A capability is a MODULE, not a permission:
// roles stay exactly as they are (see the SUPER_ADMIN note in schema.prisma for
// why widening a role enum is the expensive move). The vertical RESTRICTS;
// plans and entitlements GRANT — the effective set is the intersection, which
// is why nothing here is allowed to add a capability a plan does not include.
export type VerticalCapability =
  | 'mentorship' // mentor↔mentee relations, the mentor shell, mentee portal
  | 'evaluations' // evaluation templates, scoring, weekly reports
  | 'placements' // internship placement, offers, hiring pipeline tail
  | 'sourcing' // SOURCE role, candidate intake from partner institutions
  | 'projects' // projects and project tasks
  | 'companies' // companies, needs, requisitions
  | 'pipeline' // the stage board itself — every vertical has one
  | 'messaging' // threads, announcements, newsletter
  | 'documents'; // document requirements and uploads

export interface VerticalDefinition {
  key: VerticalKey;
  capabilities: readonly VerticalCapability[];
  // The product name shown to a SIGNED-OUT visitor, where there is no org brand
  // to read (#2356). A signed-in tenant always overrides this with its own
  // `Organization.brandName`; this is only the public-landing / no-org fallback,
  // so a marketing host stops reading "Internship CRM" in its wordmark and tab
  // title. One marketing customer today (SaleVali); a second would move this to
  // host→org branding (see issue #2457).
  productName: string;
}

// Frozen, entries and capability arrays included: verticalDefinition() hands the
// catalogue object itself to its caller, so without this a single stray push()
// anywhere would change what every later request sees for the life of the
// process — a corruption with no stack trace and no way back short of a restart.
export const VERTICALS: readonly VerticalDefinition[] = [
  {
    key: 'INTERNSHIP',
    productName: 'Internship CRM',
    // Everything. This is the product the repo already is, so its catalogue
    // entry must be a no-op: any capability missing from this list would switch
    // a live feature off for the only tenant that exists today.
    capabilities: [
      'mentorship',
      'evaluations',
      'placements',
      'sourcing',
      'projects',
      'companies',
      'pipeline',
      'messaging',
      'documents',
    ],
  },
  {
    key: 'MARKETING',
    productName: 'SaleVali',
    // A marketing CRM tracks accounts through a funnel; it has no mentors, no
    // evaluation cycle, no placement, no partner-institution intake — and no
    // intern projects (#2356): "Projects" is the internship product's team/task
    // workspace, so a marketing tenant must not see the nav entry or be able to
    // write through its APIs.
    capabilities: ['companies', 'pipeline', 'messaging', 'documents'],
  },
];

// The fallback. A row carrying a key nobody registered — a typo, a key removed
// from the catalogue while rows still hold it, a future vertical read by an
// older container mid-deploy — resolves to the product this instance already
// was. Falling back to "no product" would blank a tenant's UI; falling back to
// the full set can only ever show something that already worked.
export const DEFAULT_VERTICAL: VerticalKey = 'INTERNSHIP';

VERTICALS.forEach((v) => {
  Object.freeze(v.capabilities);
  Object.freeze(v);
});
Object.freeze(VERTICALS);

const BY_KEY = new Map<string, VerticalDefinition>(VERTICALS.map((v) => [v.key, v]));

export const VERTICAL_KEYS: VerticalKey[] = VERTICALS.map((v) => v.key);

export function isVerticalKey(value: unknown): value is VerticalKey {
  return typeof value === 'string' && BY_KEY.has(value);
}

// Normalise anything the database (or a request body) hands us to a key the
// catalogue knows. Total function on purpose: every caller downstream of a
// stored column needs an answer, not an exception.
export function toVerticalKey(value: unknown): VerticalKey {
  return isVerticalKey(value) ? value : DEFAULT_VERTICAL;
}

export function verticalDefinition(value: unknown): VerticalDefinition {
  return BY_KEY.get(toVerticalKey(value)) as VerticalDefinition;
}

// What this vertical may use. Returns a fresh array so a caller cannot mutate
// the catalogue (the arrays above are module state for the life of the process).
export function verticalCapabilities(value: unknown): VerticalCapability[] {
  return [...verticalDefinition(value).capabilities];
}

export function verticalHasCapability(value: unknown, capability: VerticalCapability): boolean {
  return verticalDefinition(value).capabilities.includes(capability);
}

// The signed-out product name for a vertical (#2356) — the wordmark/tab-title
// fallback when there is no org brand to read. Total function via toVerticalKey.
export function productNameFor(value: unknown): string {
  return verticalDefinition(value).productName;
}
