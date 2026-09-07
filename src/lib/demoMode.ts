// Public demo instance (#966).
//
// WHAT THIS IS
//   A separate deployment (demo.interncrm.com) running the same image against
//   its OWN database, seeded with prisma/seed-demo.mjs' fully synthetic data.
//   Visitors sign in with shared credentials shown on /demo and can actually
//   use the product — moving candidates through the pipeline, logging
//   interactions, creating projects.
//
// WHY IT IS WRITABLE
//   A read-only demo where every button returns 403 reads as a broken app, not
//   as a product. So writes are allowed by default and only a short, explicit
//   list is refused (DEMO_BLOCKED_WRITES below): the operations that would let
//   one visitor lock everyone else out, reach outside the demo, or park
//   arbitrary files on the host. Everything domain-shaped stays clickable.
//
// WHAT IS NOT HERE
//   There is no HTTP reset endpoint. Resetting is an operational job — a
//   scheduled workflow runs prisma/reset-demo.mjs on the server, which refuses
//   to touch a database whose name does not end in `_demo`. Keeping the
//   destructive path off the public internet means there is no reset secret to
//   leak and no route to misfire against production.
//
// ENV
//   DEMO_MODE=true  — activates everything in this file. Server-side only, and
//                     deliberately NOT NEXT_PUBLIC_: the banner is rendered by
//                     the server layout, so the flag never needs to reach the
//                     client bundle.

/** True only on the public demo deployment. */
export const IS_DEMO_MODE: boolean = process.env.DEMO_MODE === 'true';

/**
 * Write requests refused on the demo, as `[pattern, why]` pairs.
 *
 * Anchored regexes rather than prefixes, because the paths that matter include
 * dynamic segments (`/api/admin/users/<id>/erase`) and a prefix check would
 * either miss them or over-match a sibling route.
 *
 * Three kinds of thing are on this list, and nothing else belongs here:
 *   1. account takeover / lockout — the demo accounts are shared, so one
 *      visitor changing a password or wiping an account ends the demo for
 *      everyone until the next reset;
 *   2. reach outside the demo — a webhook posts to any URL the caller names
 *      (an SSRF egress from the production host), an API key is a credential,
 *      and the mail tester takes an arbitrary recipient;
 *   3. arbitrary file storage — uploads let an anonymous visitor park whatever
 *      they like on the box, which is a content-hosting liability rather than a
 *      feature worth demonstrating.
 *
 * Note that ordinary email is NOT blocked here: sendEmail() skips delivery on
 * the demo instead (see src/services/emailService.ts), so the flows stay
 * clickable and the admin email log even shows what would have been sent.
 */
export const DEMO_BLOCKED_WRITES: readonly (readonly [RegExp, string])[] = [
  // 1. account takeover / lockout
  [/^\/api\/account$/, 'changes the shared account email or password'],
  [/^\/api\/account\/2fa$/, 'would lock the shared account behind an authenticator'],
  [/^\/api\/account\/sign-out-all$/, 'signs every other visitor out'],
  [/^\/api\/admin\/users\/[^\/]+\/erase$/, 'permanently erases an account'],
  [/^\/api\/admin\/users\/[^\/]+\/reset-password$/, 'rotates a shared password'],
  // 2. reach outside the demo
  [/^\/api\/admin\/webhooks/, 'would POST from the production host to any URL'],
  [/^\/api\/admin\/api-keys/, 'mints a real API credential'],
  [/^\/api\/admin\/email-test$/, 'sends mail to an arbitrary address'],
  [/^\/api\/admin\/import$/, 'bulk-imports data from an uploaded file'],
  // 3. arbitrary file storage
  [/^\/api\/cv(\/|$)/, 'uploads a file'],
  [/^\/api\/avatar(\/|$)/, 'uploads a file'],
  [/^\/api\/documents(\/|$)/, 'uploads a file'],
  [/^\/api\/support\/attachments(\/|$)/, 'uploads a file'],
  [/^\/api\/announcements\/[^\/]+\/image$/, 'uploads a file'],
];

/**
 * The reason this write is refused on the demo, or null when it is allowed.
 * Returning the reason (rather than a bare boolean) lets the 403 tell the
 * visitor which of the three rules they hit instead of a generic refusal.
 */
export function demoBlockReason(pathname: string): string | null {
  for (const [pattern, why] of DEMO_BLOCKED_WRITES) {
    if (pattern.test(pathname)) return why;
  }
  return null;
}

/**
 * Credentials advertised on /demo. These are the accounts prisma/seed-demo.mjs
 * creates, and the password it uses — synthetic throughout, on the
 * @demo.example.com domain, so nothing here is a real address or a reusable
 * secret. Kept beside the block list on purpose: whoever changes what the demo
 * hands out should see what the demo refuses in the same file.
 */
export const DEMO_DOMAIN = 'demo.example.com';
export const DEMO_PASSWORD = 'DemoPass123!';

// Where the public demo lives. Linked from the landing page, the public footer
// and the feature catalogue on every NON-demo instance (the demo itself hides
// those links — it has the banner instead). One constant so they can't drift.
export const DEMO_URL = 'https://demo.interncrm.com';

/**
 * Which control sent the visitor to the demo.
 *
 * The demo is a *different origin*, so from the main site a click is an exit and
 * from the demo's own analytics it is a visitor from nowhere. The placement is
 * what lets the report answer "which of these links actually works" rather than
 * only "someone left" (#1391).
 *
 * `features` has no call site today — the feature catalogue
 * (`src/lib/features.ts`) carries a demo *card*, not a demo URL. It is named
 * here so that whoever adds that link reaches for the helper instead of pasting
 * a second URL.
 */
export type DemoLinkPlacement = 'hero' | 'cta' | 'footer' | 'features';

/**
 * The campaign tagging scheme for outbound demo links.
 *
 * `utm_source=crm` — the main CRM site is the referrer, as opposed to a
 * newsletter, Show HN or a directory listing;
 * `utm_medium=cta`  — an on-site button or link, not paid or mail;
 * `utm_campaign=demo` — every route into the demo shares one campaign, so the
 * report can total them and still split by `utm_content`;
 * `utm_content=<placement>` — the individual control.
 *
 * These four values are a choice, not a standard: if the maintainer already tags
 * campaigns differently elsewhere (an existing Plausible/GA report, a
 * newsletter's links), correcting them here corrects every link in the app,
 * which is the entire reason the strings live in one object.
 */
const DEMO_UTM = {
  utm_source: 'crm',
  utm_medium: 'cta',
  utm_campaign: 'demo',
} as const;

/**
 * `DEMO_URL` tagged for one call site. Built with URLSearchParams rather than
 * string concatenation so the encoding is not ours to get wrong, and so a query
 * string added to DEMO_URL later cannot produce a second `?`.
 */
export function demoUrl(placement: DemoLinkPlacement): string {
  const url = new URL(DEMO_URL);
  for (const [k, v] of Object.entries(DEMO_UTM)) url.searchParams.set(k, v);
  url.searchParams.set('utm_content', placement);
  return url.toString();
}

export const DEMO_ACCOUNTS: readonly { role: 'admin' | 'mentor' | 'mentee'; email: string }[] = [
  { role: 'admin', email: `admin.demo@${DEMO_DOMAIN}` },
  { role: 'mentor', email: `mentor.aylin@${DEMO_DOMAIN}` },
  { role: 'mentee', email: `mentee.deniz@${DEMO_DOMAIN}` },
];
