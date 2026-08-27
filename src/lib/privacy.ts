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
export const PRIVACY_POLICY_VERSION = '2026-08-25';
