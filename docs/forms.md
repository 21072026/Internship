# Admin-defined forms (#1800, story #1798)

Questions an admin adds to registration, onboarding, the profile or a mentorship request,
and the answers people give. The builder screen is #1802; rendering on registration and
profile, and scoring the matchable answers, is #1803.

## Model

| | |
|---|---|
| `FormDefinition` | `orgId`, `key`, `audience` (MENTEE · MENTOR · BOTH), `surface` (REGISTRATION · ONBOARDING · PROFILE · MENTORSHIP_REQUEST), `version`, `title`, `publishedAt`, `archivedAt`. `@@unique([orgId, key, version])`. In `TENANT_MODELS`. |
| `FormField` | `key`, `type`, `labels`, `helpText`, `options`, `required`, `matchable`, `sortOrder`, `archivedAt`. Reached through its definition, no `orgId` — deliberately unregistered (the `SurveyQuestion` reasoning). |
| `FormResponse` | `orgId`, `userId`, `definitionId`, `fieldKey`, `value`. `@@unique([userId, definitionId, fieldKey])`, `@@index([orgId, fieldKey])`. In `TENANT_MODELS`. |

Json columns carry no `@default` (MariaDB, `prisma/backfill-json-columns.mjs`); every writer
sets `labels` and `value`, the rest are nullable.

## Rules

One validator: `validateResponse()` in `src/lib/forms/schema.ts` (client-safe, shared with the
survey engine). The versioning rule is pure in `src/lib/forms/definitionRule.ts`; the only
writer is `src/lib/forms/definitions.ts`.

1. **Answers are keyed by `fieldKey`.** `latestFormAnswers()` reads the newest answer per key
   across every version of a form, archived fields included.
2. **A published version is never edited in place.** `saveFormDefinition()` rewrites a draft;
   on a published version it creates version N+1 (a draft). Only the newest version is edited
   (`draft_exists` / `not_latest`, 409). Fields left out of the edit are carried over archived.
3. **A key's type is fixed** once any version of the form was published (`field_type_locked`,
   409); sending an existing field's id with another key is `field_key_locked` (409).
4. **Free text is never matchable** — `canBeMatchable()`, refused at the write (`not_matchable`, 400).
5. **One live version.** `publishFormDefinition()` archives the older published versions in the
   same transaction; publishing twice is a 409.

## API (ADMIN, own tenant; another tenant's form is 404)

`GET|POST /api/admin/forms` · `GET|PUT|DELETE /api/admin/forms/[id]` (PUT answers 201 +
`newVersion: true` when it created a version) · `POST /api/admin/forms/[id]/publish`.

## Rendering and answering (#1803)

`src/components/forms/DynamicFields.tsx` is the ONE renderer of a surface's questions inside a
host form (`useDynamicFields(surface)` + `<DynamicFields state=…>`); it renders nothing when no
form is published, so the host form is unchanged. Mounted today: `ProfileForm` (`PROFILE`).

| Route | |
|---|---|
| `GET /api/forms/active?surface=` | The live version of each form of that surface whose audience covers the caller's role (MENTEE → MENTEE+BOTH, MENTOR → MENTOR+BOTH, any other role → none), in the caller's org. Questions only: no answers, no `matchable`. |
| `GET /api/forms/responses?surface=` | The caller's OWN latest answers to those forms, keyed `formKey → fieldKey`. |
| `PUT /api/forms/responses` | `{ definitionId, answers }`, `.strict()` — a body naming a `userId` is a 400; the person is always the session. A form the caller is not asked (another org's, a draft, another audience) is 404. Validated by `saveFormResponses()` with `validateResponse()`. A key sent empty (`null`, `''`, `[]`) clears that answer across every version of the form; a key left out is untouched. |

Selection lives in `src/lib/forms/active.ts` (`activeForms`, `publicForm`, `ownAnswers`).
