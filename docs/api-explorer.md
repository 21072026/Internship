# The admin API explorer

`/admin/api-explorer` is a Swagger UI page, for admins only, driven by
`GET /api/admin/openapi` — an OpenAPI 3.1 document describing **every** HTTP
endpoint this app exposes, derived from the route files themselves.

This page explains how that document is produced, why it is produced at build
time, how authentication works when you press *Try it out*, and why the whole
thing is behind an ADMIN check.

---

## Why it is admin-only

There are two API descriptions in this repo, and the distinction matters:

| | `/api/v1/openapi.json` | `/api/admin/openapi` |
|---|---|---|
| Audience | integrators | maintainers |
| Access | **public**, no credential | **ADMIN session only**, 401 otherwise |
| Covers | the key-authenticated `/api/v1` surface + the outgoing-webhook contract | all ~300 operations, including admin, cron, inbound-mail and webhook receivers |
| Source | hand-written (`src/app/api/v1/openapi.json/route.ts`) | generated (`scripts/openapi-generate.cjs`) |

The public one is deliberately small. The internal one is a complete route
inventory: every admin action, every scheduled-job trigger, the guard each one
runs, and the request bodies they accept. That is reconnaissance an attacker
would otherwise have to assemble by hand over weeks, so it must never be
reachable without a signed-in ADMIN session. `src/app/api/admin/openapi/route.ts`
uses the same `requireAdmin()` shape and the same `401 {"error":"Unauthorized"}`
body as `src/app/api/admin/api-keys/route.ts`.

The two documents do not overlap. The internal one links to the public one via
`externalDocs` instead of restating the webhook contract — one copy of a contract
is the right number, and the public copy is the one integrators actually read.
`npm run check:openapi` asserts the public route still exists and still declares
its own `securitySchemes` and `x-webhooks`.

---

## Why the spec is built at build time

The Docker runner stage copies only `public/`, `.next/`, `node_modules/`,
`package.json` and `prisma/`. **Neither `src/` nor `next.config.js` exists in
the production container.** So "walk `src/app/api` when the admin requests the
spec" cannot work — there would be nothing to walk.

Instead:

```
next.config.js
  └─ require('./scripts/openapi-generate.cjs').buildSpec(__dirname)
       └─ nextConfig.env.APP_OPENAPI_SPEC = JSON.stringify(spec)   (~310 KB)
            └─ webpack DefinePlugin inlines it into the server bundle
                 └─ src/app/api/admin/openapi/route.ts parses it behind requireAdmin()
```

This is the same mechanism `scripts/release-derive.cjs` uses for the displayed
version (#1275), and it has three properties worth keeping:

* **The document cannot drift from the code.** It is rebuilt by the same command
  that builds the code, so a route added in a PR is in the spec of that PR's
  preview environment.
* **Nothing under `src/` imports a generated file.** The route reads a *string*
  from `process.env`, with a `|| ''` fallback. So `npx tsc --noEmit` on a fresh
  clone — before any codegen has run — has nothing to look for, and there is no
  ordering hazard between the codegen step and the typecheck step in CI.
* **It cannot break a build or a boot.** `buildSpec()` returns `null` rather
  than throwing when `src/app/api` is missing, and the call in `next.config.js`
  is wrapped in a `try`; the endpoint then answers `503` with "run `npm run
  gen:openapi` and rebuild" rather than serving an empty document that looks like
  "this app has no endpoints". Note that the runner stage ships neither `src/`
  **nor `next.config.js`** — the config never runs in the production container at
  all. `next start` there uses the config baked into
  `.next/required-server-files.json`, which is also how the inlined spec reaches
  the running server.

There is deliberately **no `prebuild`/`predev`/`prelint` hook**. A `prestart`-ish
hook would make `npm start` in the production container attempt work it cannot
do, and the other hooks are unnecessary because nothing imports the artefact.

### Regenerating by hand

```bash
npm run gen:openapi      # writes src/generated/openapi.json (pretty-printed)
npm run check:openapi    # re-derives and asserts the invariants below
```

`src/generated/openapi.json` is **gitignored**. It is a convenience artefact for
reading the output — nothing imports it. Committing it would mean a ~500 KB diff
in every PR that adds or renames a route, which is precisely the churn the
release-fragment mechanism exists to avoid.

The output is deterministic (paths sorted, methods in a fixed order), so two runs
on the same tree are byte-identical; `check:openapi` verifies that, because a
non-deterministic generator would produce a spurious diff on every build.

---

## What the generator can and cannot know

`scripts/openapi-generate.cjs` parses each `route.ts` with the **TypeScript AST**
(`typescript` is a devDependency, present in the Docker builder stage, which
installs devDeps). It is a static analyser, not a type checker, so its guiding
rule is: *say less rather than guess wrong.*

**Derived reliably**

* the URL path (`[id]` → `{id}`, `[...nextauth]` → `{nextauth}` + `x-catch-all`,
  and `openapi.json` stays a literal segment — brackets are tested before dots)
* which HTTP verbs are exported, in all three syntactic forms present
  (`export async function GET`, `export function GET`,
  `export { handler as GET }`) plus `export const GET =` for future use
* path parameters, cross-checked against the `params: Promise<{...}>` annotation
  (a mismatch fails `check:openapi`)
* query parameters, from every `searchParams.get('literal')` including the three
  ways the bag gets bound
* the guard, **including guards that live in a module-scope helper** — helper
  bodies are inlined before classification, which is what stops
  `POST /api/inbound-email`, `POST /api/webhooks/jaas`,
  `GET /api/admin/document-requirements` and `GET /api/health` from being
  labelled "no credential required"
* prose summaries and descriptions from the route's own leading comment (210 of
  the handlers have one), sanitised — see below

**Deliberately approximate**

* **Role lists.** `role === 'X'` is not a session-role check in a third of its
  occurrences here (Prisma `where` clauses, `ProjectMember.role`, business
  branches). Comparisons only count when they are anchored on `session.user.role`
  or a local alias of it, **and** appear in a guard whose first statement is a
  401/403 return. Polarity matters: `!== 'ADMIN'` guarding a 401 means "ADMIN
  required"; `=== 'MENTEE'` guarding a 401 means "MENTEE rejected", which is the
  opposite (`x-roles-denied`). Where the guard cannot be followed — it is behind
  an unnamed boolean helper, or the roles come out of a lookup table — the
  operation says only `any-session`. Under-stating access is recoverable;
  over-stating it is how generated docs start lying.
* **Request bodies.** A module-scope `z.object({...})` is resolved properly,
  including nested object arrays, `z.enum`, `z.record`, `z.union` (→ `oneOf`),
  `.strict()` (→ `additionalProperties: false`) and local schema references.
  A `.partial().extend()` composition or a schema imported from another module
  is **not** guessed at: those emit a free-form object with
  `x-body-source: "unknown"` / `"zod-partial"` and a note naming the symbol.
* **Responses.** Status codes are collected from the handler text, plus the
  middleware 403 that applies to writes by unverified users, plus the 401 implied
  by the guard. Bodies are typed only as far as "an object" or, for the 18
  binary/`text/calendar` handlers, as a binary stream.

`x-auth-approximate: true` marks an operation whose role guard is combined with a
per-record check (ownership, tenancy, step-up auth). `x-source` names the file to
read when you need the authoritative answer.

### Vendor extensions

| Extension | Meaning |
|---|---|
| `x-auth` | the guard class: `admin-session`, `role-session`, `any-session`, `api-key`, `cron-secret`, `shared-secret`, `signed-token`, `opaque-token`, `path-token`, `saml-assertion`, `nextauth`, `public` |
| `x-auth-alternatives` | further classes when an endpoint accepts more than one credential |
| `x-roles` / `x-roles-denied` | roles allowed / rejected outright |
| `x-auth-approximate` | per-record checks apply on top of the role check |
| `x-internal` | `false` only for `/api/v1` |
| `x-source` | the route file, for when you need the real answer |
| `x-body-source` | `zod`, `zod-partial`, `form-data`, `unknown` |
| `x-destructive` | irreversible, or sends real mail — the explorer puts a confirmation in front of *Try it out* (see below) |
| `x-catch-all`, `x-try-it` | the NextAuth catch-all; exercising it can end your own session, so the explorer gates it too |
| `x-rate-limited`, `x-tenant-scoped`, `x-step-up-auth` | secondary attributes |

### The *Try it out* gate

`ApiExplorer.tsx` enforces those two flags in its `requestInterceptor`, which
Swagger UI calls after it has built the request and before it reaches `fetch`.
A request is guarded when any of three things is true:

* the operation carries `x-destructive`;
* the operation carries `x-try-it: false`;
* **the method is `DELETE`** — regardless of annotation. The generator's curated
  `x-destructive` list marks exactly one of the 31 `DELETE` operations, and a
  gate that trusted only the annotation would be wrong precisely where being
  wrong costs the most, so here the method wins over the document.

A guarded request pops a native `window.confirm` naming the method and the
resolved URL. Declining throws out of the interceptor, so the request is never
handed to `fetch` at all; Swagger catches the rejection and renders the
cancellation in that operation's own response panel. `window.confirm` rather
than the app's own `ConfirmDialog` on purpose: it is synchronous and modal, so
there is no window in which a re-render or a second click can slip the request
past it. `showMutatedRequest: false` is part of the same mechanism, not a
cosmetic setting — Swagger's response panel reads the *mutated* request, which
is only recorded after the interceptor returns, so on a cancelled request it
would be null and the panel would throw while rendering.

`e2e/api-explorer.spec.ts` covers this by watching the network: it declines the
confirmation on `DELETE /api/admin/api-keys` and asserts no such request was
ever sent.

### Excluding a comment: `@openapi-ignore`

A route comment that would be harmful to republish can opt out. Put the literal
string `@openapi-ignore` anywhere in a handler's leading comment block and the
generator leaves that comment out of the description; the comment stays in the
source, where it is still worth reading.

Use it for notes that are useful to a developer *because* they say where the
guarantees stop — the kind of thing that reads as a to-do list to anyone probing
the app. `src/app/api/availability/route.ts` is the worked example: its `GET`
comment names `orgContext`'s `TENANT_MODELS` and spells out that every model
outside that list falls beyond the central tenant-isolation guarantee. Next to
`x-source`, which names the exact file for every route, that is a map. It stays
in the file; it does not go in the document.

Do **not** reach for it to tidy a description. Deleting a route from the reader's
view is the failure mode this whole document exists to avoid; the marker removes
a *comment*, and the operation, its guard class and its `x-source` are still
published.

### Comment sanitising

Route comments are internal engineering notes, not API docs. Before a comment
becomes a description, any line that names an env var ending in
`SECRET`/`TOKEN`/`KEY`/`PASSWORD`, contains a URL, names an internal host, or
quotes `process.env.` is dropped. That removes about fifteen lines across the
corpus and damages no description — but it removes the operator runbook line that
puts a webhook secret in a query string, and the comment explaining exactly why
the health endpoint fails open. `check:openapi` re-scans the *generated* text for
those patterns, so the sanitiser is verified rather than trusted.

The all-caps rule requires the `SECRET|TOKEN|KEY|PASSWORD` suffix on purpose:
role and enum names (`MENTEE`, `COMPANY`, `IN_PROGRESS`) appear in comments over
a hundred times and are legitimate documentation.

**Any comment line containing a URL is dropped**, whether or not there is a
secret anywhere near it. That is deliberate — it errs safe, because a URL in an
internal note is as likely to be an internal host or a webhook endpoint with a
token in the query string as it is to be a link to a spec. It is also blunt, and
it has a visible casualty: the operator setup instructions in
`src/app/api/webhooks/jaas/route.ts` (lines 12-16) are gutted, so the published
description reads as a fragment. If you find a description that stops
mid-thought, this rule is the first thing to suspect — open the `x-source` file
and read the real comment.

---

## Authentication in the explorer

The document declares exactly two security schemes:

* **`sessionCookie`** — the NextAuth session cookie (`apiKey`, `in: cookie`).
  You are already carrying it, and `servers: [{ url: '/' }]` keeps *Try it out*
  on the same origin, so requests run **as you, with your own permissions**. This
  covers the large majority of operations. It also means a *Try it out* on a
  destructive endpoint really is destructive — the gate described above asks
  first, but confirming it means the thing happens, to this environment's data.
* **`bearerApiKey`** — an admin-issued `icrm_…` key, for the `/api/v1` surface.
  The explorer mints one through the **existing** `POST /api/admin/api-keys`
  route: no new token type and no new auth path, so every key created from the
  page lands in the admin activity log (`apikey.created`, level `warning`) like
  any other. The raw key is shown exactly once.

  `ApiKey` has no `expiresAt` column, so nothing on the server ever retires a
  key minted here — which is why the page revokes it for you. Navigating away
  inside the app revokes it on unmount (an ordinary request on a page that is
  still alive), and closing the tab or hard-reloading fires the same `DELETE`
  with `keepalive` from a `pagehide` handler. That second path is genuinely best
  effort — a killed browser or an offline machine leaves the key alive — so the
  copy on the card still tells you to revoke it, and the *Revoke* button is
  still there. (`navigator.sendBeacon` is not usable for this: it only sends
  POST.)

Endpoints guarded some other way (a shared-secret header, an unguessable token in
the URL, a SAML assertion) declare `security: []` and carry the real mechanism in
`x-auth` and in the description. Only two schemes are declared because only two
are things a browser session can actually present.

Those descriptions **name the header** — `x-cron-secret`, `x-inbound-secret`,
`x-webhook-secret` — and that is on purpose. A header name is not a credential;
the value is, and no value appears anywhere in this document (`check:openapi`
re-scans the generated text to keep it that way). Withholding the name would buy
nothing an attacker could not read off the route file, while costing the reader
the difference between a callable endpoint and a mystery — which is the entire
point of publishing an inventory.

Two things that will surprise you in the UI:

* On the shared demo (`DEMO_MODE=true`), `POST /api/admin/api-keys` is blocked by
  the demo write blocklist — it mints a real credential. Generating a token there
  returns 403 with the demo explanation. That is correct; there is no bypass.
* An admin who has not verified their email address gets `403 {"error":"Please
  verify your email address to make changes."}` on every write, from
  `src/middleware.ts`, before the handler runs.

---

## What `npm run check:openapi` guarantees

Wired into `ci.yml` next to the other `check:*` gates. It fails on:

1. a `route.ts` that contributes no operation (a handler shape the analyser does
   not recognise — the silent-drop failure mode)
2. a path parameter that does not match the route's `params` annotation
3. a duplicate `operationId` (Swagger UI drops one of a pair without saying so)
4. an operation with no summary, no `x-auth` or no responses
5. an `/api/admin/*` operation that does not resolve to an ADMIN guard — either a
   real authorization hole or a guard shape the analyser cannot follow, and both
   need a human. `role-session` counts when ADMIN is among the roles:
   `POST /api/admin/duplicates/check` is intentionally ADMIN-or-MENTOR.
6. redacted text that leaked into a generated summary or description
7. non-deterministic output
8. the public `/api/v1/openapi.json` route being removed or losing its own
   `securitySchemes` / `x-webhooks`

It does **not** check that a derived request body matches what the handler
accepts. Bodies are best-effort by design, and an honest `x-body-source:
"unknown"` is not a failure.
