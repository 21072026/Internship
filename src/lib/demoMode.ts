// Public demo instance (#966).
//
// WHAT THIS IS
//   A separate deployment (crm-demo.ersah.in) running the same image against
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

export const DEMO_ACCOUNTS: readonly { role: 'admin' | 'mentor' | 'mentee'; email: string }[] = [
  { role: 'admin', email: `admin.demo@${DEMO_DOMAIN}` },
  { role: 'mentor', email: `mentor.aylin@${DEMO_DOMAIN}` },
  { role: 'mentee', email: `mentee.deniz@${DEMO_DOMAIN}` },
];
