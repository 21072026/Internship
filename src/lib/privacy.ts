// Version of the privacy notice / data-processing terms shown at registration.
// Bump this (date-based) whenever the notice materially changes so that the
// accepted version is recorded per user (GDPR Art. 7 demonstrability) and — in a
// later slice — users can be asked to re-consent. Keep in sync with the
// `privacy.lastUpdated` copy in the dictionaries.
// 2026-08-24: names tawk.to as a recipient of the visitor's IP and chat content
// on the public home page, after marketing-cookie opt-in (#1177).
// 2026-08-25: names the controller and a real contact address instead of saying
// the operator would supply them before production use (#1396). Nothing about
// the processing changed, so no existing consent is invalidated — there is no
// version comparison anywhere that could wall a signed-in user (the renew flow
// is driven by retention mail, not by this constant). New registrations simply
// record that they accepted the notice that actually names a controller.
// 2026-09-29: a section on the company enquiry / demo request forms (#2569) —
// which fields are stored, the campaign parameters and referrer (origin and
// path only), the host, no IP, that the product-news box is only a request
// until confirmed, and how long it is kept. The enquiry row stamps this version
// as `consentTextVersion`, so the text it names must describe what it stores.
export const PRIVACY_POLICY_VERSION = '2026-09-29';

// Version of the product-news opt-in WORDING on the marketing demo form
// (`companyInquiry.marketingOptIn` in the dictionaries, #2569). Separate from
// the privacy version: that one is the notice, this one is the sentence the
// person ticked. Bump it whenever that sentence changes in any language.
export const MARKETING_OPT_IN_TEXT_VERSION = '2026-09-29';
