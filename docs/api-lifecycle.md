# The `/api/v1` lifecycle policy

What an integrator can plan against (#1992). The same policy is published on the
public `/developers` page and in the OpenAPI document's `x-lifecycle` block; all
three read `src/lib/api/v1Lifecycle.ts`, so change the numbers there, never in
prose alone.

## What `v1` guarantees

The contract version is the path: `/api/v1`. Within it, a change is **additive only**:

- new endpoints, new optional query parameters and new optional body fields;
- new fields in a response object;
- new error `type` values, new webhook events and new event versions (`name@2`
  next to `name@1`, § Published contracts in [`public-api.md`](public-api.md)).

Clients must ignore what they do not know: an unknown field, an unknown error type
or an unknown event. The OpenAPI `info.version` is the deployment's version (the
build that answered), not the contract's.

## What counts as breaking

Removing or renaming a field, parameter or endpoint; changing a field's type or
nullability; making an optional parameter or field required; tightening validation
so that a request accepted today is refused; changing the meaning of an error
`type` or the status it answers with; changing a published webhook payload.

## How a breaking change ships

1. It is **announced at least 6 months** (`DEPRECATION_WINDOW_MONTHS`) before the
   old behaviour stops, with an entry in `API_DEPRECATIONS` — which feeds the
   `/developers` table, `x-lifecycle.deprecations` and § Deprecations in
   [`public-api.md`](public-api.md).
2. A deprecated **operation** answers with `Deprecation` (RFC 9745) and `Sunset`
   (RFC 8594) headers from the day it is announced. A deprecated **key inside a
   response** cannot be marked by a header — that would mark the whole endpoint —
   so it is listed in the table only (the `candidates` alias of #1988 is the example).
3. If the change cannot keep that promise, it ships as an **opt-in parameter within
   v1** (the old behaviour stays the default) or as **v2** next to v1.

## Changelog

Every shipped change, the API's included, is dated on `/release-notes` (one release
per fragment, `releases/README.md`). The developer-facing detail is in `CHANGELOG.md`.
