# Public conversion events (#1388)

`src/lib/track.ts` extends the existing #1391 sender; there is one transport helper
and no new SDK, beacon endpoint, identity store or tracking cookie. Event names in
`ANALYTICS_EVENTS` are stable API-like identifiers: renaming one splits historical
funnels and needs an explicit migration decision.

| Event name | Exact trigger | Question answered |
| --- | --- | --- |
| `signup_completed` | Registration POST returns 2xx and its response body is accepted, before navigating to sign-in | How many signup forms finish successfully? |
| `signup_verified` | Email verification POST returns 2xx, separately from registration | How many registrations reach mailbox verification? |
| `mentor_application_submitted` | Mentor application POST returns 2xx | How many prospective mentors submit an application? |
| `company_inquiry_submitted` | Company enquiry POST returns 2xx, including the marketing demo variant | How many company/demo enquiry forms succeed? |
| `demo_cta_click` | Existing DemoLink click, with its finite placement | Which demo entry points are used? |
| `role_card_selected` | A landing role card's destination link is clicked, with its finite role | Which audience door do visitors choose? |
| `features_viewed` | Features page is mounted with consent and a loaded provider; once per mount | How many consenting visitors examine capabilities? |
| `pricing_viewed` | Existing pricing page is mounted under the same conditions | How many examine pricing? |

A successful neutral/anti-spam response is counted as a successful submission,
not proof of a new database row. Failures, rejected passwords, duplicate/rate-limit
errors and failed verification responses never emit form conversions.

## Consent and privacy

Every call rereads `hasConsent('analytics')` before touching a vendor. Missing
providers and provider exceptions are silent. No form/click event is buffered or
replayed after consent. Page views can wait for the existing consent-gated loader
while that page remains mounted. No analytics providers are added to auth or CRM
shells: direct verification visits without an already loaded provider are silent,
so these are consent/provider-observed funnel counts, not total database counts.

The typed property contract allows only finite `role` and `placement` categories.
Exact generic keys reject extra properties even on variables; runtime validation
rebuilds the payload from the same allowlist. Never add email, name, phone, user,
mentee/company IDs, free text, URLs or arbitrary string values. This CRM holds
private case information, so even innocent-looking event properties can identify
a person. Consumed invitation/verification query parameters are removed before
successful auth conversions, to keep those credentials out of SDK URL metadata.

Provider loading/CSP configuration remains in `analytics.ts` / `AnalyticsScripts`.
PostHog retains `autocapture: false`, `persistence: 'memory'` and
`disable_session_recording: true`. The existing provider-global call conventions
and navigation beacon options are retained; this change does not introduce user
identification or third-party scripts on authenticated pages.
