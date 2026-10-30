# The Zapier app (#2004)

`apps/zapier/` is a Zapier Platform CLI project (`zapier-platform-core`) over the
public API. Its contract is `/api/v1/openapi.json`; it adds no endpoint of its own.

| Kind | Key | API |
|---|---|---|
| Auth | `custom`, an API key as `Authorization: Bearer` | test: `GET /api/v1/me`, connection label = the organisation's name |
| Trigger | `new_application` | REST hook on `application.created` |
| Trigger | `pipeline_stage_changed` | REST hook on `pipeline.stage_change` |
| Trigger | `offer_accepted` | REST hook on `offer.accepted` |
| Trigger | `meeting_scheduled` | REST hook on `meeting.scheduled` |
| Trigger | `interview_request_created` | REST hook on `interview_request.created` |
| Action | `create_candidate` | `POST /api/v1/candidates` |
| Action | `log_interaction` | `POST /api/v1/interactions` |
| Action | `update_stage` | `PATCH /api/v1/relationships/{id}/stage` |
| Search | `find_candidate` (+ find-or-create) | `GET /api/v1/candidates/{id}` or `GET /api/v1/candidates?email=` |

## How it behaves

- **Triggers are REST hooks** (#2002). Turning a Zap on POSTs `/api/v1/hooks`
  `{ targetUrl, event }`; the subscription belongs to the API key of the
  connection, and only that key can list or delete it. Turning the Zap off
  DELETEs it (a hook that is already gone counts as done). Zapier receives the
  signed `{ event, data, sentAt }` body; the trigger outputs `data` plus an `id`
  taken from `X-Delivery-Id`, which is stable across retries, so Zapier dedupes a
  redelivery.
- **Samples.** Every trigger carries a sample in the catalogue's payload shape,
  and its list step returns that sample, so a Zap can be built before any real
  event. No list endpoint returns these exact payloads, so there is no polling
  fallback: a "load more samples" returns the documented shape, not a different
  object.
- **Every action sends an `Idempotency-Key`** (#1994): a SHA-256 of the Zap id,
  the action and its input. Zapier retries a step it thinks failed, and users
  replay runs; the same Zap with the same input sends the same key, so the API
  answers the replay with the first result instead of creating a second row.
- **Errors keep the API's `type`** (`duplicate_candidate`, `insufficient_scope`,
  `stage_conflict` …) so a Zap's error message names the actual refusal.
- **The key decides what the app can do.** Give it only the scopes the Zaps
  need: `hooks:write` for triggers, `candidates:read/write`,
  `interactions:write`, `relationships:write` for the actions. A company or
  source key works for what its ceiling allows (`docs/public-api.md`).

## Where it points: preview by default, never production

The base URL is the Zapier environment variable `ICRM_BASE_URL`, and without
it the app talks to the shared **preview** (`https://preview.interncrm.com`),
never production. The same rule applies to the repo's load tests: a
development version pushed without its environment set, or a reflexive
`npm run smoke`, cannot touch the live site. The smoke script also refuses the
production host outright. Only the promoted public version sets
`ICRM_BASE_URL=https://interncrm.com` (`zapier-platform env:set <version> …`).

## Testing

- `npm test`: offline tests (`node --test` + nock + `createAppTester`). They
  cover the auth test and label, the subscribe/unsubscribe cycle, the delivery
  id, the samples, the Idempotency-Key, error types and both search lookups.
  Runs in CI (`.github/workflows/zapier.yml`) with `npm run validate`.
- `npm run smoke`: the auth test, one hook subscribe → unsubscribe and one search
  against a deployed environment, through the app's own code.
  `SMOKE_WRITE=1` also creates one synthetic candidate and replays the create to
  prove the Idempotency-Key. Needs `ICRM_API_KEY` from that environment, which is
  never committed.

### Against a PR environment

Every PR gets `https://pr<N>.interncrm.com` with its own database and the demo
admin (`admin.demo@demo.example.com` / `DemoPass123!`, synthetic data only):

1. Sign in there, open Admin › Integrations and mint a key with the scopes above.
2. `ICRM_BASE_URL=https://pr<N>.interncrm.com ICRM_API_KEY=icrm_… npm run smoke`
   (add `SMOKE_WRITE=1` freely: the database is the PR's own).
3. For a live Zap, push a **private development version**
   (`zapier-platform push`) and set its env to the PR host:
   `zapier-platform env:set <version> ICRM_BASE_URL=https://pr<N>.interncrm.com`.
   Delete that version when the PR closes; its environment is gone by then.

## Versioning and the breaking-change procedure

- The app's version is `apps/zapier/package.json` → `version`
  (`index.js` reads it). Bump it on every push to Zapier: patch for a fix,
  minor for a new trigger/action/field, major for a breaking change.
- **A promoted Zapier version is immutable.** Live Zaps keep running the
  version they were built on until they are migrated. So:
  - **Additive** (a new optional input, a new output field, a new trigger): push
    a minor version, promote it, then `zapier-platform migrate <old> <new>`.
    Zaps move over without the user doing anything.
  - **Breaking** (a removed or renamed field, a changed payload shape, a trigger
    on a different event): never edit a promoted version. The API side ships
    first, as a **new event version** (`name@2`, the catalogue never reshapes a
    published version, #1611). Then push a **major** app version that uses
    it, promote it, and migrate in stages (`zapier-platform migrate <old>
    <new> 10`, then 100) while watching the error rate. The old version stays
    deprecated, not deleted, until no Zap runs on it. Breaking changes that
    cannot be mapped automatically go to users through
    `zapier-platform deprecate` with a date, never a silent edit.
  - The webhook contract snapshot (`scripts/test/fixtures/webhook-payloads.json`)
    is what tells you a payload change is breaking: if it fails, the change is
    breaking for this app too.

## Directory submission checklist

**Current blocker:** the app is not registered with Zapier yet. That needs a
Zapier developer account owned by the rights holder (`zapier-platform register`,
which writes `.zapierapprc` with the app id) and a `ZAPIER_DEPLOY_KEY` for any
automated push. Both are the maintainer's decision and are not in this
repository. Until then the app lives here as code with green CI.

- [ ] Register the app on the maintainer's Zapier account and commit `.zapierapprc`.
- [ ] Push 1.0.0 with `ICRM_BASE_URL` set to production on that version only.
- [ ] Private beta: share the invite link with the first customers (no listing
      needed). Zapier's public listing asks for a number of live users with active
      Zaps before review; read the current number on the submission form, since
      it changes.
- [ ] Branding: a square app icon (256×256 PNG, the product mark on a plain
      background), the app title, a one-line tagline and a description that
      names the five triggers, three actions and the search.
- [ ] A public help page for the integration (scopes to give the key, where to
      mint it), linked from the submission.
- [ ] A test account for Zapier's reviewers on a **demo** host with synthetic
      data, never a customer tenant.
- [ ] `zapier-platform validate` (with style checks, after login) clean, then
      submit for review.
