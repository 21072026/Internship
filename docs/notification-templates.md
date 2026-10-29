# Notification templates (#1718)

An organization — and, once programmes exist (#1618), a single programme — can
override the words of any notification event, per locale, without a deploy.
The data layer is #1718; the editor and the sender are #1719.

## The chain

`resolveTemplate(eventKey, locale, { orgId, programId, params, recipientName, brand })`
(`src/lib/notifications/templates.ts`) answers `{ subject, html, source, fallback?, templateId? }`:

1. the **programme's** row (`programId` = the programme id), else
2. the **org's** row (`programId = ''`), else
3. the **code default**: the dictionary line `notifications.events.<key>` in the
   same locale (`codeDefault()`), as subject and as a one-paragraph body.

Only rows of the **recipient's** locale are read. A locale nobody wrote is the
code default in that language — a German org's people never receive the Turkish
override. An org with no rows behaves exactly as before; nothing is seeded.

`programId` is a non-null `VarChar` with `''` for "org-wide" because MySQL treats
NULLs as distinct in a unique index — a nullable column would let two org-wide
rows for one event and locale coexist under `@@unique([orgId, programId, eventKey, locale])`.

## Untrusted input

A stored template is written by an org admin and rendered into mail, so the
renderer (`src/lib/notifications/templateRender.ts`, pure, unit-tested with
hostile input in `scripts/test/notification-templates.test.mjs`) never passes it
through:

- **Body** — tokenised and *rebuilt* from an allowlist: `p br strong b em i u a
  ul ol li h2 h3 blockquote`; the only attribute is `href` on `<a>`, http/https/
  mailto only (entities and control characters decoded/stripped before the scheme
  is read), or exactly `{{brand.url}}`. Everything else — `<script>`, `<style>`,
  `<img>` beacons, `on*=`, `style=`, `javascript:`/`data:` — does not reach the
  output; every text run is escaped.
- **Merge tags** — `{{name}}`. Allowed: the catalogue entry's `params` plus
  `{{brand.name}}`, `{{brand.url}}`, `{{recipient.firstName}}`. A value is
  escaped into the body (sanitising runs first, so a value can never become
  markup); any other tag renders literally and reads nothing.
- **Subject** — plain text: entities decoded first, then tags removed until none
  is left (`stripTags()` — one pass over `<<b>script>` would leave `<script>`) and
  any stray `<`/`>` dropped, line breaks collapsed, ≤ 255 chars.

## Fail safe

A stored row whose subject comes out empty or names a tag the event does not
carry, whose body sanitises to nothing, or whose rendering throws is **not used**:
the code default is, `fallback` says why (`empty_subject`, `unknown_subject_tag`,
`empty_body`, `render_error`, `read_error`) and a `notification_template.fallback`
log line records it. A bad template never silences a notification.

## Tenancy

`NotificationTemplate` carries `orgId` (cascade on org delete) and is in
`TENANT_MODELS`.

## The editor and the sender (#1719)

**One renderer.** `renderNotificationEmail()` (`src/lib/notifications/emailRender.ts`)
builds the whole mail around `resolveTemplate()`: the brand header, the body, the
"Open in the app" button (a relative link only) and the From name. It has three
callers, and that is the point:

- the `notification.email` job (`src/lib/notifications/emailJob.ts`, registered in
  `src/jobs/index.ts`), which consumes what the router's e-mail channel enqueues;
- `POST /api/admin/notification-templates/preview`, with the unsaved `draft`;
- `POST /api/admin/notification-templates/test`, with the draft or the stored copy.

`resolveTemplate()` takes the `draft` IN PLACE of the stored rows and renders it with the
same code (`source: 'draft'`), so the preview pane is the mail. The e2e spec compares the
preview route's HTML with a direct `renderNotificationEmail()` call.

**The sender.** The job claims the router's `NotificationDelivery` row QUEUED → SENT with one
guarded `updateMany` before it sends, so a rerun sends nothing; a send that throws puts the
row back to QUEUED and rethrows for the worker's retry. It does **not** send `batched` events
(their mail belongs in a digest that does not exist yet → `SKIPPED batched_deferred`) or a
job older than a day (`SKIPPED stale` — the queue held unread rows before this consumer
existed). The mail category comes from `EVENT_MAIL_CATEGORY` (`eventMailRule.ts`), one
existing category per e-mail group; a unit spec holds every entry against the taxonomy and
the outbound-approval list.

**The editor.** `/admin/notification-templates` (linked from `/admin/settings`) lists the
events whose mail is sent (`EDITABLE_EVENTS` in `templateAdmin.ts` — an in-app-only event has
nothing to edit), grouped by e-mail group, with a programme selector when programmes exist.
Per language: subject, body, the merge tags this event carries (`mergeTagsFor()`), a live
preview in a fully sandboxed iframe, save, "send me a test" and reset. Routes:

- `GET/PUT/DELETE /api/admin/notification-templates` — `org.settings.write`, the caller's
  org, a `programId` of that org only (another's is 404). PUT refuses a template the resolver
  would not use at send time (`checkTemplateDraft()`: empty subject, unknown subject tag,
  empty body, too long). DELETE removes the row, so the default (or the org's row, for a
  programme) applies again. Every write is an ActivityLog row.
- `preview` and `test` take a `.strict()` body: a `to` is refused. The test goes to the
  session's own address under the `test` category.
