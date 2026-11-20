# Provisioning strategy: scheduled roster feeds, contract-gated SCIM (#1970)

Reviewed against main on **2026-11-16**. Decision owner: the maintainer. Tracking:
[#1970](https://github.com/21072026/Internship/issues/1970), HRIS story
[#1968](https://github.com/21072026/Internship/issues/1968), initiative
[#1514](https://github.com/21072026/Internship/issues/1514).

## What exists today

| Capability | Supported behaviour and evidence |
|---|---|
| Invitations | Email-based invitations and acceptance; see [access matrix](role-access-matrix.md), [`/api/invite`](../src/app/api/invite/route.ts) and [registration/acceptance](../src/app/api/register/route.ts). |
| CSV import | Manual candidate import creates mentees, with dry run and per-row results; see [`/api/admin/import`](../src/app/api/admin/import/route.ts) and the shared [import engine](roster-feed.md). A manual upload alone does not offboard missing people. |
| SSO JIT provisioning | A verified SSO identity can create a user at login and map the IdP role; [SSO provisioning and role mapping](sso-saml.md) and [`ssoProvisioning.ts`](../src/lib/ssoProvisioning.ts). Login-time directory sync is not offboarding push. |
| Scheduled roster feed | SFTP or HTTPS CSV ingestion, delta, dry run, run history and automatic deprovisioning; [#1963](https://github.com/21072026/Internship/issues/1963), [engine/configuration](roster-feed.md), [offboarding rules](roster-feeds.md), [`rosterFeedRunner.ts`](../src/lib/rosterFeedRunner.ts). Configure and enable a UTC schedule, such as nightly, and separately enable deprovisioning. |

The feed covers **mentees in its own organization**, not admins, mentors or hiring
managers. Deprovisioning is off by default. Once enabled, the first successful
absence stamps a date; a later successful run after the configured grace period
(default one UTC calendar day) deactivates the account, invalidates prior sessions
on their next request and revokes remembered devices and push tokens. Row floors,
a deactivation ceiling and protected accounts can stop offboarding; unreadable
rows prevent deprovisioning. A failed, paused or stale upstream feed can therefore
leave access open longer. Monitor runs and alerts and use admin deactivation for
urgent removals. This is scheduled ingestion, **not real-time** access revocation.

## Deliberately deferred

**SCIM 2.0, Workday and SAP SuccessFactors are not shipped.** A customer's HR
system exporting a CSV does not constitute a direct HRIS connector. Personio and
BambooHR adapters are separately proposed in #1968; this record promises no HRIS
API integration.

The reviewed decision, quoted from [#1970](https://github.com/21072026/Internship/issues/1970):

> SCIM 2.0. Listed P0 in two domains. It is a full protocol server — Users, Groups, PATCH semantics, filter grammar, Okta and Entra certification — and it presupposes F1, F2 and F4. Before a second real tenant exists it returns literally zero. Scheduled SFTP/CSV delta ingestion with automatic deprovisioning is a fifth of the cost, closes the same mid-market deals, and is what 10KC actually runs for ADP and Oracle. Do that; keep SCIM for the first buyer who names it in a contract.

The go-to-market review, also quoted in #1970:

> SCIM 2.0, sub-organisations, multi-region residency, HRIS connectors (Workday/SuccessFactors/BambooHR). These exist to win the 5,000-employee L&D deal we are not bidding on. Offer scheduled SFTP/CSV ingestion instead.

These are historical review judgements, including comparative cost and competitor
claims, not a current delivery estimate or independently verified sales claim.
The [research](research/competitive-analysis-2026-08.md#8-risks-and-explicit-non-goals)
already records the non-goal; this is its operational decision record, not a new roadmap.

## Unlock condition: all gates must be yes

A request, prospect questionnaire or unsigned opportunity does not unlock work.
For **each named protocol/system**, the maintainer must record links to evidence
for every row below in the implementation issue before work starts:

| Gate | Evidence required for a yes |
|---|---|
| Signed demand | A signed contract explicitly names SCIM 2.0, Workday or SAP SuccessFactors and funds that scope. Record a restricted contract reference, never confidential contract contents in this public repository. A contract naming one does not unlock the others. |
| Tenant isolation (F1) | [#1549](https://github.com/21072026/Internship/issues/1549) rollout prerequisites complete, two-tenant leak checks passing, enforcement enabled on preview and production, with deployment evidence. Having middleware alone is insufficient. |
| Permission model (F2) | Server-enforced role/capability model landed, with a reviewed mapping from external users/groups to tenant and programme permissions, including refusal of privilege escalation and cross-tenant writes. |
| Programme object / platform spine (F4) | Programme identity and membership/scope boundaries landed, with the required settings, tenant resolution and durable ingestion/job infrastructure usable by the proposed integration. Link the actual models, guards and tests. |

**Current assessment:** the gate is not met. No signed-contract evidence is
recorded here. [`orgScope.ts`](../src/lib/orgScope.ts) still defaults enforcement
off; [tenant-isolation rollout evidence](tenant-isolation.md#flip-readiness-3588-evidence-of-2026-11-13)
is readiness evidence, not proof of a production flip.

The issue's August snapshot is partly outdated: it says there is only a Role enum
and any admin can change any org's SSO. Main now has [admin tiers and permissions](role-access-matrix.md),
`requirePermission`, organization/world scoping and super-admin IdP trust guards
in [`organizations/route.ts`](../src/app/api/admin/organizations/route.ts)
([#1524](https://github.com/21072026/Internship/issues/1524)). Programme scope also
exists in current models and settings (see [tenant-isolation.md](tenant-isolation.md)).
Do not rebuild these foundations or copy the stale vulnerability claim. Their
existence does not establish an approved SCIM mapping or satisfy all gates.

## Future SCIM scope estimate (planning only)

Keep the research's **XL / 8 story points** as a historical size marker, not a
calendar commitment. The work breakdown below is the minimum basis for a new
estimate once the contract and mapping exist; include integration QA and operations,
not only routes. None of these endpoints or protocol behaviours is implemented here.

| Work package | Scope to estimate and verify |
|---|---|
| Protocol boundary | Tenant-bound credentials, schema/discovery responses, pagination, SCIM error responses, rate limits, auditing and credential revocation. |
| `/Users` | Create, read/list, update, deactivate/reactivate and deletion policy; stable IDs, external IDs, attribute ownership, retries and tenant-safe uniqueness. |
| `/Groups` | Create/read/update/delete, membership changes and approved group-to-role/programme mappings; never infer privileged access from an arbitrary group name. |
| PATCH semantics | Ordered add/replace/remove, paths and value paths, multi-valued attributes, atomicity/error handling and idempotent retries. |
| Filter grammar | Capture the filters actually sent by the contracted Okta and Entra configurations. Budget equality lookups on `userName`, `externalId`, group `displayName` and membership/value-path queries as candidates; confirm the needed operators, escaping and case rules against traces. Implement and test the agreed subset, reject unsupported expressions explicitly; this is not a claim that all clients send one fixed subset. |
| Bulk operations | Capability negotiation, operation limits, `bulkId` references, ordering, per-operation results and `failOnErrors`; explicitly negotiate any exclusion before reducing this estimate. |
| ETags / concurrency | Resource versions, `If-Match`, stale-write rejection, races between feed/SSO/admin writes and SCIM, and safe retries without lost updates. |
| Okta and Entra interoperability / certification | Separate real-tenant test matrices: initial import, matching, group push, rename, deactivate/reactivate, retries, filters, pagination and concurrency. Budget vendor application setup, certification/submission requirements where applicable, evidence and retesting; a local stub is insufficient. |

Direct Workday or SAP SuccessFactors connectors need their own source/API,
credential, attribute and failure-mode estimate after their individual gate;
the SCIM estimate does not include them.

## Buyer-facing answer and accepted gap

The canonical, copyable **EN/TR/DE** answer to “Do you support SCIM?” is in the
existing [security questionnaire answer library](trust/questionnaire-answers.md#provisioning-do-you-support-scim).
The accepted gap, compensating control and next review are in
[security exceptions](security-exceptions.md#scim-20-ve-doğrudan-hris-bağlayıcıları-1970).
