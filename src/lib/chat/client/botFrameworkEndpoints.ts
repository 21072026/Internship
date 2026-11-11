// The Bot Framework's own hosts, kept under src/lib/chat/client/ with every
// other platform URL: e2e/chat-adapter.spec.ts pins that no file outside the
// client names one, so a second platform (or a URL change) touches one place.
// Read by src/lib/chat/botFrameworkAuth.ts (#3322).

/** The `iss` every Bot Framework token must carry. */
export const BOT_FRAMEWORK_ISSUER = 'https://api.botframework.com';

/** Where the signing keys are published; TEAMS_OPENID_METADATA_URL overrides it for the e2e stub. */
export const BOT_FRAMEWORK_OPENID_METADATA_URL = 'https://login.botframework.com/v1/.well-known/openidconfiguration';
