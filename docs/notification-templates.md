# Notification templates (#1718)

An organization — and, once programmes exist (#1618), a single programme — can
override the words of any notification event, per locale, without a deploy.
This is the data layer; the admin editor is #1719.

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
- **Subject** — plain text: tags removed, line breaks collapsed, ≤ 255 chars.

## Fail safe

A stored row whose subject comes out empty or names a tag the event does not
carry, whose body sanitises to nothing, or whose rendering throws is **not used**:
the code default is, `fallback` says why (`empty_subject`, `unknown_subject_tag`,
`empty_body`, `render_error`, `read_error`) and a `notification_template.fallback`
log line records it. A bad template never silences a notification.

## Tenancy

`NotificationTemplate` carries `orgId` (cascade on org delete) and is in
`TENANT_MODELS`.
