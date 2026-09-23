/**
 * Which TEXT_LIMITS constant guards which database column (#1433, #2262).
 *
 * WHY IT IS A MODULE AND NOT A LIST INSIDE THE TEST
 *   This map started life inside `e2e/text-limits-columns.unit.spec.ts`, which
 *   made it Playwright-only: the invariant it encodes — *no zod cap may be
 *   wider than the column behind it* — was checked in the scheduled full suite
 *   and nowhere in the PR gate. A cap that is too wide does not fail a test, it
 *   500s in production the first time somebody pastes a long line, so it wants
 *   to fail on the PR that writes it. `npm run check:text-limits` reads this
 *   file directly under Node's type stripping; the spec still reads it too, for
 *   the behavioural half (a zod schema built from the constant accepts the
 *   column's capacity exactly and rejects one character more).
 *
 * WHAT THE CHECK DOES AND DOES NOT COVER — read this before trusting it
 *   COVERED, in both directions, for every model listed below:
 *     - every `String` column of that model is accounted for: either a
 *       constant, or an exemption with a written reason;
 *     - no stale entry for a column the schema no longer has;
 *     - the constant fits what the column can actually hold, parsed out of
 *       prisma/schema.prisma rather than retyped here;
 *     - every file named in `files` references the constant, so a route cannot
 *       quietly go back to an inline number.
 *   NOT COVERED:
 *     - a model that is not in this map at all. Adding one is the point of the
 *       registry, and it is the honest limit of the guard: it stops the listed
 *       surfaces from drifting, it does not discover new ones.
 *     - a TEXT_LIMITS constant with no row here (they are not all
 *       column-backed — several bound e-mail bodies or composed strings).
 *       Closing that direction needs every constant to declare what it guards;
 *       tracked separately rather than half-done here.
 */
import type { TextLimitKey } from '@/lib/textLimits';

export type Guard =
  /** The constant that bounds this column, and every file that must use it. */
  | { limit: TextLimitKey; files: string[] }
  /** Not free text a user types — say why, so the next reader can disagree. */
  | { exempt: string };

/** A cuid the server generates, or a foreign key that has to match a real row. */
export const ID: Guard = { exempt: 'an id — server-generated, or matched against an existing row' };

/** Set by the server from the session/upload, never typed into a form. */
const SERVER_SET: Guard = { exempt: 'written by the server, not by a user' };

/** One of a fixed set of values, bounded by the enum rather than by a length. */
const ENUMERATED: Guard = { exempt: 'a value from a fixed set — bounded by the set, not by a length' };

const COMPANY_WRITERS = [
  'src/app/api/companies/route.ts',
  'src/app/api/companies/[id]/route.ts',
  'src/components/forms/CompanyForm.tsx',
];
const TASK_WRITERS = [
  'src/app/api/todos/route.ts',
  'src/app/api/projects/[id]/tasks/route.ts',
  'src/app/api/project-tasks/[taskId]/route.ts',
  'src/components/todos/MyTodos.tsx',
  'src/components/todos/PersonTodos.tsx',
  'src/components/todos/TodoRow.tsx',
];
const TEMPLATE_WRITERS = [
  'src/lib/goalTemplates.ts',
  'src/app/api/admin/goal-templates/route.ts',
  'src/app/api/projects/[id]/task-templates/route.ts',
];
const PROJECT_WRITERS = ['src/app/api/projects/route.ts', 'src/app/api/projects/[id]/route.ts'];
const GOAL_WRITERS = ['src/app/api/goals/route.ts', 'src/app/api/goals/[id]/route.ts'];
const ORG_WRITERS = ['src/app/api/admin/organizations/route.ts'];
const PROFILE_WRITERS = ['src/app/api/profile/route.ts', 'src/components/ProfileForm.tsx'];
// The marketing account import (#2406) is the only writer of the four account
// columns #2405/#2407 added; its validator carries their caps.
const MARKETING_IMPORT_WRITERS = ['src/lib/marketingImport.ts'];

export const COLUMN_GUARDS: Record<string, Record<string, Guard>> = {
  Company: {
    id: ID,
    orgId: ID,
    name: { limit: 'companyName', files: COMPANY_WRITERS },
    description: { limit: 'companyDescription', files: COMPANY_WRITERS },
    contactEmail: { limit: 'companyContactEmail', files: COMPANY_WRITERS },
    industry: { limit: 'companyIndustry', files: COMPANY_WRITERS },
    logoUrl: { limit: 'companyLogoUrl', files: COMPANY_WRITERS },
    size: { limit: 'companySize', files: COMPANY_WRITERS },
    address: { limit: 'companyAddress', files: COMPANY_WRITERS },
    // No company FORM writes these yet (#2405/#2407): the importer's validator
    // is the writer that has to carry their caps. A form that starts offering
    // them adds itself here beside the importer.
    contactName: { limit: 'companyContactName', files: MARKETING_IMPORT_WRITERS },
    contactPhone: { limit: 'companyContactPhone', files: MARKETING_IMPORT_WRITERS },
    vatId: { limit: 'companyVatId', files: MARKETING_IMPORT_WRITERS },
    country: { limit: 'companyCountry', files: MARKETING_IMPORT_WRITERS },
    externalId: {
      exempt:
        'no request path writes it (#2446 is the column; the nightly usage sync that stamps it is #2447). It is not typed by a person at all — the feed matches on it and fills it as a gap — so the cap belongs on that validator, which the data contract already fixes at the column width: docs/marketing-vertical/salevali-usage-feed.md § Alanlar. A form or route that ever offers this field replaces this exemption with a limit.',
    },
  },
  CompanyNeed: {
    id: ID,
    companyId: ID,
    position: { limit: 'companyNeedPosition', files: COMPANY_WRITERS },
    period: { limit: 'companyNeedPeriod', files: COMPANY_WRITERS },
  },
  ProjectTask: {
    id: ID,
    projectId: ID,
    assigneeId: ID,
    createdById: ID,
    templateId: ID,
    title: { limit: 'todoTitle', files: TASK_WRITERS },
  },
  ProjectTaskTemplate: {
    id: ID,
    projectId: ID,
    createdById: ID,
    // The same constant as ProjectTask.title, and not by coincidence: a
    // template's wording is written into a task's title unchanged.
    title: { limit: 'todoTitle', files: TEMPLATE_WRITERS },
  },

  // ── Added by #2262 ────────────────────────────────────────────────────────
  Project: {
    id: ID,
    orgId: ID,
    ownerUserId: ID,
    ownerCompanyId: ID,
    contributorTermsKey: { exempt: 'a key from src/lib/contributorTerms, capped at 60 by its own schema' },
    name: { limit: 'projectName', files: PROJECT_WRITERS },
    description: { limit: 'projectDescription', files: PROJECT_WRITERS },
    goals: { limit: 'projectGoals', files: PROJECT_WRITERS },
    repoUrl: { limit: 'projectUrl', files: PROJECT_WRITERS },
    demoUrl: { limit: 'projectUrl', files: PROJECT_WRITERS },
    boardUrl: { limit: 'projectUrl', files: PROJECT_WRITERS },
  },
  Goal: {
    id: ID,
    relationId: ID,
    title: { limit: 'goalTitle', files: GOAL_WRITERS },
    description: { limit: 'goalDescription', files: GOAL_WRITERS },
  },
  MeetingRequest: {
    id: ID,
    relationId: ID,
    requestedById: ID,
    topic: { limit: 'meetingTopic', files: ['src/app/api/meeting-requests/route.ts'] },
  },
  Document: {
    id: ID,
    ownerId: ID,
    uploaderId: ID,
    requirementId: ID,
    filename: SERVER_SET,
    contentType: SERVER_SET,
    title: { limit: 'documentTitle', files: ['src/app/api/documents/route.ts'] },
  },
  User: {
    id: ID,
    orgId: ID,
    companyId: ID,
    sourceId: ID,
    referredById: ID,
    externalId: ID,
    password: SERVER_SET,
    referralCode: SERVER_SET,
    icsFeedToken: SERVER_SET,
    twoFactorSecret: SERVER_SET,
    avatarUrl: SERVER_SET,
    cvUrl: SERVER_SET,
    email: { exempt: 'bounded by the address itself; every write path parses it as an e-mail first' },
    fullName: { exempt: 'capped by the register/profile schemas at 191 or below' },
    phone: { exempt: 'capped by the profile schema well below the column' },
    whatsapp: { exempt: 'capped by the profile schema well below the column' },
    displayName: { exempt: 'capped by the profile schema well below the column' },
    country: ENUMERATED,
    timezone: ENUMERATED,
    preferredLanguage: ENUMERATED,
    theme: ENUMERATED,
    fontSize: ENUMERATED,
    density: ENUMERATED,
    accentColor: ENUMERATED,
    testimonialNameStyle: ENUMERATED,
    referralSource: ENUMERATED,
    targetPosition: { exempt: 'capped by the profile schema well below the column' },
    city: { limit: 'profileShortText', files: PROFILE_WRITERS },
    university: { limit: 'profileShortText', files: PROFILE_WRITERS },
    department: { limit: 'profileShortText', files: PROFILE_WRITERS },
    linkedinUrl: { limit: 'profileUrl', files: PROFILE_WRITERS },
    githubUrl: { limit: 'profileUrl', files: PROFILE_WRITERS },
    portfolioUrl: { limit: 'profileUrl', files: PROFILE_WRITERS },
    bio: { limit: 'bio', files: PROFILE_WRITERS },
    interests: { exempt: '@db.Text, capped by the profile schema' },
    reEngageNote: { exempt: '@db.Text, written by an admin through its own route' },
  },
  MentorApplication: {
    id: ID,
    orgId: ID,
    decidedById: ID,
    locale: ENUMERATED,
    fullName: { exempt: 'capped at 120 by the application schema' },
    email: { exempt: 'bounded by the address itself; parsed as an e-mail first' },
    phone: { exempt: 'capped at 191 by the application schema' },
    experience: { limit: 'mentorApplicationExperience', files: ['src/app/api/mentor-applications/route.ts'] },
    motivation: { limit: 'mentorApplicationMotivation', files: ['src/app/api/mentor-applications/route.ts'] },
    linkedinUrl: { limit: 'profileUrl', files: ['src/app/api/mentor-applications/route.ts'] },
    rejectReason: { exempt: '@db.Text, written by an admin decision route' },
    adminNote: { exempt: '@db.Text, written by an admin decision route' },
  },
  CompanyInquiry: {
    id: ID,
    orgId: ID,
    handledById: ID,
    convertedCompanyId: ID,
    locale: ENUMERATED,
    companyName: { exempt: 'capped at 160 by the public form schema' },
    contactName: { exempt: 'capped at 120 by the public form schema' },
    phone: { exempt: 'capped at 40 by the public form schema' },
    email: { limit: 'companyContactEmail', files: ['src/app/api/company-inquiry/route.ts'] },
    openRoles: { exempt: '@db.Text, capped at 300 by the public form schema' },
    message: { limit: 'publicContactMessage', files: ['src/app/api/company-inquiry/route.ts'] },
    note: { exempt: '@db.Text, written by an admin on the triage screen' },
  },
  Organization: {
    id: ID,
    stripeCustomerId: ID,
    name: { exempt: 'capped at 120 by the create schema; tenants are created by a super-admin only' },
    slug: { exempt: 'slugified and sliced to 60 by the route before it is written' },
    vertical: ENUMERATED,
    ssoProvider: ENUMERATED,
    brandName: { limit: 'orgBrandName', files: ORG_WRITERS },
    brandColor: { limit: 'orgBrandColor', files: ORG_WRITERS },
    supportEmail: { limit: 'orgSupportEmail', files: ORG_WRITERS },
    ssoIssuer: { limit: 'orgSsoIssuer', files: ORG_WRITERS },
    brandLogoUrl: { exempt: '@db.Text, capped at 2000 by the route' },
    ssoEntryPoint: { exempt: '@db.Text, capped at 2000 by the route' },
    ssoCertificate: { exempt: '@db.Text, capped at 20000 by the route' },
    billingEmail: { exempt: 'written by the billing flow, not typed into this form' },
    vatId: { exempt: 'written by the billing flow, not typed into this form' },
    billingCountry: ENUMERATED,
  },
};
