// What a tenant offboarding export may carry (#1584, docs/tenant-lifecycle.md
// § Export). Pure and dependency-free; the walker that applies it is
// src/lib/orgExport.ts and the unit test (scripts/test/org-export-policy.test.mjs)
// runs it against the real Prisma schema.
//
// THE PROMISE. The export is the tenant's own data, complete enough to answer
// "how do we get our data out": every row of every model that carries this
// org's `orgId`, and every row reached from those through a foreign key. What
// it never carries is a credential — something that would let the holder of the
// file act as somebody (a password hash, a session or sign-in token, an API key
// hash, a webhook or drain signing secret, an OAuth token, the SSO keys) — and
// the omissions are listed in the file's `_meta`, so the customer can see what
// was left out and why rather than guess.
//
// FAIL CLOSED. Any scalar column whose NAME looks like a credential
// (`SECRET_LIKE`) must be decided here — omitted, or listed in `KEPT_FIELDS`
// with the reason it is not one. A new `fooToken` column nobody decided fails
// the unit test instead of shipping in the next export.

/** Models left out entirely: each row IS a credential, or is the platform's machinery rather than the tenant's data. */
export const OMITTED_MODELS: Readonly<Record<string, string>> = Object.freeze({
  PasswordResetToken: 'single-use credential',
  LoginLinkToken: 'single-use credential',
  EmailVerificationToken: 'single-use credential',
  TrustedDevice: 'remember-me credential',
  SessionRefreshGrant: 'single-use credential',
  ImpersonationGrant: 'single-use credential',
  SsoLoginGrant: 'single-use credential',
  SsoAuthRequest: 'single-use credential: the OIDC state, nonce and PKCE verifier of a login in flight (#1929)',
  TwoFactorRecoveryCode: 'second-factor credential',
  PushSubscription: 'device push endpoint keys (a credential to that device)',
  NativePushToken: 'device push token (a credential to that device)',
  Job: 'platform queue machinery; queued mail is a sealed envelope',
  JobRun: 'platform queue machinery',
});

/** Columns left out of otherwise exported rows, by `Model.field`. */
export const OMITTED_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  'Organization.ssoCertificate': 'SSO trust anchor',
  'Organization.ssoSpKey': 'SAML signing private key',
  'Organization.ssoSpCert': 'SAML signing certificate (re-issued on re-setup)',
  'Organization.publicHostToken': 'domain verification token',
  'Organization.ssoClientSecretEnc': 'OIDC client secret',
  'User.password': 'password hash',
  'User.twoFactorSecret': 'TOTP secret',
  'User.lastTotpStep': 'TOTP replay floor',
  'User.icsFeedToken': 'calendar feed bearer token',
  'ApiKey.hashedKey': 'API key hash',
  'Webhook.secret': 'webhook signing secret',
  'AuditDrain.secret': 'audit drain signing secret',
  'GoogleCalendarConnection.accessTokenEnc': 'OAuth token',
  'GoogleCalendarConnection.refreshTokenEnc': 'OAuth token',
  'CalendarConnection.accessTokenEnc': 'OAuth token',
  'CalendarConnection.refreshTokenEnc': 'OAuth token',
  'ChatWorkspace.botTokenEnc': 'OAuth token',
  'ChatWorkspace.refreshTokenEnc': 'OAuth token',
  'RosterFeed.secretEnc': 'feed credential',
  'InvitationToken.token': 'invitation bearer token',
  'Meeting.rsvpToken': 'RSVP bearer token',
  'MeetingGuest.rsvpToken': 'RSVP bearer token',
  'DocumentReview.reviewToken': 'review bearer token',
  'SurveyInvitation.tokenHash': 'survey link hash',
  'SurveyInvitationToken.tokenHash': 'survey link hash',
  'ContactSuppression.keyHash': 'suppression lookup key',
  'ContributorTermsAcceptance.ipHash': 'pseudonymous network identifier',
  'ContributorTermsAcceptance.uaHash': 'pseudonymous device identifier',
  'MentoringAgreementAcceptance.ipHash': 'pseudonymous network identifier',
  'MentoringAgreementAcceptance.uaHash': 'pseudonymous device identifier',
});

/** Columns whose name looks like a credential but are not one — each with why. */
export const KEPT_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  'Organization.ssoCertWarnFp': 'fingerprint of a public certificate, for the expiry warning',
  'Organization.ssoCertWarnStage': 'which expiry warning was sent',
  'IntegrationSource.apiKeyId': 'a row id, not the key',
  'Webhook.apiKeyId': 'a row id, not the key',
  'ApiKeyUsage.apiKeyId': 'a row id, not the key',
  'ApiIdempotencyKey.apiKeyId': 'a row id, not the key',
  'ApiIdempotencyKey.requestHash': 'digest of a request body, replays nothing',
  'ApiImport.apiKeyId': 'a row id, not the key',
  'ApiExport.apiKeyId': 'a row id, not the key',
  'Offer.signingBonusMinor': 'money, not a signing key',
  'AiUsage.inputTokens': 'a count of model tokens',
  'AiUsage.outputTokens': 'a count of model tokens',
  'AiArtifact.inputHash': 'cache key of a model input',
  'JaasMonthlyParticipant.participantHash': 'billing-meter digest',
  'ExternalProfileLink.emailHash': 'match key for an upstream record',
  'RosterFeed.credentialEnvVar': 'the NAME of an environment variable, never its value',
  'RosterRun.fileHash': 'digest of an imported file',
  'User.ssoPhotoUrlHash': 'digest of the IdP photo claim, so an unchanged photo is not re-downloaded',
  'ChatWorkspace.tokenExpiresAt': 'a timestamp',
});

/** A column name that must be decided above. */
export const SECRET_LIKE = /(password|secret|token|hash|cert|privatekey|spkey|apikey|recovery|totp|otp|signing|credential|cookie|salt|nonce)/i;

export function isModelOmitted(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(OMITTED_MODELS, model);
}

export function isFieldOmitted(model: string, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(OMITTED_FIELDS, `${model}.${field}`);
}

/** The secret-looking columns of a schema nobody decided. Empty = the policy covers the schema. */
export function undecidedSecretFields(models: readonly { name: string; fields: readonly { name: string; kind: string }[] }[]): string[] {
  const out: string[] = [];
  for (const m of models) {
    if (isModelOmitted(m.name)) continue;
    for (const f of m.fields) {
      if (f.kind !== 'scalar' || !SECRET_LIKE.test(f.name)) continue;
      const key = `${m.name}.${f.name}`;
      if (!(key in OMITTED_FIELDS) && !(key in KEPT_FIELDS)) out.push(key);
    }
  }
  return out;
}

/** Entries that name a column the schema no longer has (a stale line). */
export function staleEntries(models: readonly { name: string; fields: readonly { name: string }[] }[]): string[] {
  const have = new Set<string>();
  const modelNames = new Set<string>();
  for (const m of models) {
    modelNames.add(m.name);
    for (const f of m.fields) have.add(`${m.name}.${f.name}`);
  }
  return [
    ...Object.keys(OMITTED_FIELDS).filter((k) => !have.has(k)),
    ...Object.keys(KEPT_FIELDS).filter((k) => !have.has(k)),
    ...Object.keys(OMITTED_MODELS).filter((k) => !modelNames.has(k)),
  ];
}

export interface WalkModel {
  name: string;
  hasOrgId: boolean;
  /** FK edges to other models: the scalar columns on THIS model and the model they point at. */
  parents: readonly { model: string; fields: readonly string[]; references: readonly string[] }[];
}

/**
 * The export order: first every model carrying `orgId`, then — level by level —
 * every model reached through a single-column foreign key from a model already
 * in the plan, each with the edges to follow. Omitted models are never planned
 * and never walked through. Pure, so the unit test pins it on the real schema.
 */
export function planWalk(models: readonly WalkModel[]): { model: string; via: { field: string; parent: string; parentKey: string }[] }[] {
  const plan: { model: string; via: { field: string; parent: string; parentKey: string }[] }[] = [];
  const planned = new Set<string>();
  for (const m of models) {
    if (m.hasOrgId && !isModelOmitted(m.name) && m.name !== 'Organization') {
      plan.push({ model: m.name, via: [] });
      planned.add(m.name);
    }
  }
  for (;;) {
    const level: typeof plan = [];
    for (const m of models) {
      if (planned.has(m.name) || isModelOmitted(m.name) || m.name === 'Organization') continue;
      const via = m.parents
        .filter((p) => planned.has(p.model) && p.fields.length === 1 && p.references.length === 1)
        .map((p) => ({ field: p.fields[0], parent: p.model, parentKey: p.references[0] }));
      if (via.length) level.push({ model: m.name, via });
    }
    if (!level.length) break;
    for (const l of level) {
      plan.push(l);
      planned.add(l.model);
    }
  }
  return plan;
}
