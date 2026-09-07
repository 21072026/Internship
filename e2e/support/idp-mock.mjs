// A stand-in identity provider — SAML 2.0 and OIDC — used only by the e2e run
// (#1936).
//
// WHY THIS EXISTS: Enterprise SSO (#545) is the feature most likely to be broken
// by an unrelated change and least likely to be noticed, because nothing
// exercised a round trip. `e2e/sso-saml-mapping.spec.ts` and
// `e2e/sso-provisioning.spec.ts` test pure functions; the only end-to-end recipe
// was a human clicking through the public mocksaml.com, which CI cannot depend
// on (docs/security-audit-playbook.md §7 listed "live SAML SSO end-to-end" as
// never examined). This is the same trick e2e/support/google-mock.mjs plays for
// Google Calendar: a local process that speaks the real wire format, so the
// app's own verification path — signature, audience, recipient, expiry — runs
// for real against something we can also make deliberately wrong.
//
// KEY MATERIAL IS GENERATED AT START-UP AND NEVER WRITTEN TO DISK. A committed
// private key is a finding in a public repo regardless of what it protects, so
// the spec asks this process for the matching public certificate over HTTP
// (`GET /__state`) and stores that on the tenant, exactly as a customer would
// paste in their IdP's certificate.
//
// Two key pairs exist: the one whose certificate is advertised, and a "rogue"
// one that is never advertised. The rogue key is what makes the negative cases
// honest — an assertion signed by it is a correctly-formed assertion from the
// wrong issuer, which is the attack the signature check exists to stop.
//
// The only non-stdlib import is `xml-crypto`, which is a direct dependency of
// @node-saml/node-saml (so it is always installed) and is the same library the
// app verifies with. Reaching into a transitive dependency is a deliberate
// trade: the alternative is hand-rolling exclusive canonicalisation, and a
// major bump of xml-crypto under node-saml would break the smoke test loudly
// rather than silently.

import { createServer } from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { SignedXml } from 'xml-crypto';

const PORT = Number(process.env.IDP_MOCK_PORT || 4600);
const ORIGIN = `http://127.0.0.1:${PORT}`;

// The SAML EntityID this stub claims. A tenant stores it as `ssoIssuer`.
const SAML_ISSUER = 'urn:e2e:stub-idp';
const OIDC_ISSUER = `${ORIGIN}/oidc`;

// --- Minimal DER / X.509 --------------------------------------------------
//
// Node can generate an RSA key pair but cannot wrap the public half in a
// self-signed certificate, and IdPs hand out certificates, not bare public
// keys. Shelling out to `openssl` would make the harness depend on a binary
// that may not exist on a contributor's machine, and a certificate fixture on
// disk is the thing we are refusing to commit. So: ~60 lines of DER, verified
// by `new crypto.X509Certificate(pem)` at start-up, which throws if any of it
// is malformed.

function der(tag, body) {
  const len = body.length;
  let lenBytes;
  if (len < 0x80) {
    lenBytes = Buffer.from([len]);
  } else {
    const b = [];
    let n = len;
    while (n > 0) {
      b.unshift(n & 0xff);
      n >>>= 8;
    }
    lenBytes = Buffer.from([0x80 | b.length, ...b]);
  }
  return Buffer.concat([Buffer.from([tag]), lenBytes, body]);
}
const derSeq = (...parts) => der(0x30, Buffer.concat(parts));
const derSet = (...parts) => der(0x31, Buffer.concat(parts));
const derNull = () => der(0x05, Buffer.alloc(0));
const derUtf8 = (s) => der(0x0c, Buffer.from(s, 'utf8'));
const derBitString = (buf) => der(0x03, Buffer.concat([Buffer.from([0]), buf]));

function derOid(dotted) {
  const parts = dotted.split('.').map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const stack = [part & 0x7f];
    let rest = part >>> 7;
    while (rest > 0) {
      stack.unshift((rest & 0x7f) | 0x80);
      rest >>>= 7;
    }
    bytes.push(...stack);
  }
  return der(0x06, Buffer.from(bytes));
}

function derInt(value) {
  let b = Buffer.isBuffer(value) ? value : Buffer.from([value]);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); // keep it positive
  return der(0x02, b);
}

function derUtcTime(date) {
  const p = (n) => String(n).padStart(2, '0');
  const s =
    `${p(date.getUTCFullYear() % 100)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
  return der(0x17, Buffer.from(s, 'ascii'));
}

const OID_COMMON_NAME = '2.5.4.3';
const OID_SHA256_RSA = '1.2.840.113549.1.1.11';
const derName = (cn) => derSeq(derSet(derSeq(derOid(OID_COMMON_NAME), derUtf8(cn))));

function selfSignedCertificate(publicKey, privateKey, commonName) {
  const algorithm = derSeq(derOid(OID_SHA256_RSA), derNull());
  const now = Date.now();
  const tbs = derSeq(
    der(0xa0, derInt(2)), // [0] EXPLICIT version, v3
    derInt(crypto.randomBytes(8)), // serial
    algorithm,
    derName(commonName), // issuer == subject (self-signed)
    derSeq(derUtcTime(new Date(now - 60_000)), derUtcTime(new Date(now + 86_400_000))),
    derName(commonName),
    publicKey.export({ type: 'spki', format: 'der' })
  );
  const signature = crypto.sign('sha256', tbs, privateKey);
  const body = derSeq(tbs, algorithm, derBitString(signature))
    .toString('base64')
    .match(/.{1,64}/g)
    .join('\n');
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

function makeKeyMaterial(commonName) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const certificate = selfSignedCertificate(publicKey, privateKey, commonName);
  new crypto.X509Certificate(certificate); // throws if the DER above is wrong
  return { publicKey, privateKey, certificate };
}

// Advertised to the app; the tenant stores `signing.certificate`.
const signing = makeKeyMaterial('e2e-stub-idp');
// NEVER advertised. Signing with it produces a well-formed assertion from an
// issuer the tenant did not trust — the case the signature check exists for.
const rogue = makeKeyMaterial('e2e-stub-idp-rogue');

const bareCert = (pem) => pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');

// --- SAML -----------------------------------------------------------------

const iso = (d) => d.toISOString();
const uid = () => `_${crypto.randomBytes(16).toString('hex')}`;
const xmlEscape = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
const xmlUnescape = (s) =>
  String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/**
 * Pull the two things an IdP needs out of the SP's AuthnRequest: where to post
 * the answer, and who the answer is for. Reading them from the request instead
 * of from test configuration is what keeps the negatives honest — the audience
 * and recipient in the assertion are then whatever the app itself asked for, so
 * a rejection can only be the defect the case is named after (and it also means
 * the stub does not care what NEXTAUTH_URL is set to).
 */
export function parseAuthnRequest(samlRequestB64) {
  const xml = zlib.inflateRawSync(Buffer.from(samlRequestB64, 'base64')).toString('utf8');
  const acs = /AssertionConsumerServiceURL="([^"]+)"/.exec(xml);
  const issuer = /<(?:[\w.-]+:)?Issuer\b[^>]*>([^<]+)<\/(?:[\w.-]+:)?Issuer>/.exec(xml);
  const id = /\bID="([^"]+)"/.exec(xml);
  return {
    xml,
    acsUrl: acs ? xmlUnescape(acs[1]) : null,
    // The SP's EntityID, which is also the audience it will check against.
    spEntityId: issuer ? xmlUnescape(issuer[1]) : null,
    requestId: id ? xmlUnescape(id[1]) : null,
  };
}

export const SAML_MODES = [
  'ok',
  'wrong-key', // signed by a key the tenant does not trust
  'bad-signature', // signed correctly, then a byte of the SignatureValue flipped
  'unsigned', // no <Signature> at all
  'expired', // Conditions/SubjectConfirmationData NotOnOrAfter in the past
  'wrong-audience', // AudienceRestriction names another SP
];

/**
 * Build a SAML Response for the given AuthnRequest. `mode` decides which single
 * thing about it is wrong; everything else stays valid, so a rejection is
 * attributable.
 */
export function buildSamlResponse({ acsUrl, audience, email, name, mode = 'ok', inResponseTo }) {
  const now = new Date();
  const skewSafe = 60_000; // comfortably past node-saml's 5s accepted clock skew
  const expired = mode === 'expired';
  const notBefore = new Date(now.getTime() - (expired ? 10 * 60_000 : skewSafe));
  const notOnOrAfter = new Date(now.getTime() + (expired ? -5 * 60_000 : 5 * 60_000));
  const aud = mode === 'wrong-audience' ? 'https://not-this-sp.e2e.local/sso/someone-else' : audience;

  const [first, ...restOfName] = (name || '').trim().split(/\s+/).filter(Boolean);
  const last = restOfName.join(' ');
  const assertionId = uid();

  const attribute = (attrName, value) =>
    `<saml:Attribute Name="${xmlEscape(attrName)}" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:basic">` +
    `<saml:AttributeValue>${xmlEscape(value)}</saml:AttributeValue></saml:Attribute>`;

  const assertion =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" Version="2.0" IssueInstant="${iso(now)}">` +
    `<saml:Issuer>${xmlEscape(SAML_ISSUER)}</saml:Issuer>` +
    `<saml:Subject>` +
    `<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${xmlEscape(email)}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
    `<saml:SubjectConfirmationData NotOnOrAfter="${iso(notOnOrAfter)}" Recipient="${xmlEscape(acsUrl)}"` +
    `${inResponseTo ? ` InResponseTo="${xmlEscape(inResponseTo)}"` : ''}/>` +
    `</saml:SubjectConfirmation>` +
    `</saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(notBefore)}" NotOnOrAfter="${iso(notOnOrAfter)}">` +
    `<saml:AudienceRestriction><saml:Audience>${xmlEscape(aud)}</saml:Audience></saml:AudienceRestriction>` +
    `</saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="${assertionId}">` +
    `<saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext>` +
    `</saml:AuthnStatement>` +
    `<saml:AttributeStatement>` +
    attribute('email', email) +
    (first ? attribute('firstName', first) : '') +
    (last ? attribute('lastName', last) : '') +
    `</saml:AttributeStatement>` +
    `</saml:Assertion>`;

  let signedAssertion;
  if (mode === 'unsigned') {
    signedAssertion = assertion;
  } else {
    const key = mode === 'wrong-key' ? rogue : signing;
    const sig = new SignedXml({
      privateKey: key.privateKey,
      signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
      canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
    });
    sig.addReference({
      xpath: "//*[local-name(.)='Assertion']",
      transforms: [
        'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
        'http://www.w3.org/2001/10/xml-exc-c14n#',
      ],
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    });
    // Real IdPs ship the certificate inside <KeyInfo>. The app ignores it and
    // verifies against the certificate the tenant stored — which is the whole
    // point — but sending it keeps the wire format faithful.
    sig.getKeyInfoContent = () =>
      `<X509Data><X509Certificate>${bareCert(key.certificate)}</X509Certificate></X509Data>`;
    // The signature must be a direct child of the element it covers, right
    // after <Issuer>; node-saml rejects a Signature whose parent is not the
    // referenced node.
    sig.computeSignature(assertion, {
      location: { reference: "//*[local-name(.)='Issuer']", action: 'after' },
    });
    signedAssertion = sig.getSignedXml();

    if (mode === 'bad-signature') {
      signedAssertion = signedAssertion.replace(
        /(<(?:\w+:)?SignatureValue[^>]*>)([A-Za-z0-9+/=\s]+)(<)/,
        (_m, open, value, close) => {
          const trimmed = value.trim();
          const flipped = (trimmed[0] === 'A' ? 'B' : 'A') + trimmed.slice(1);
          return `${open}${flipped}${close}`;
        }
      );
    }
  }

  const response =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ` +
    `ID="${uid()}" Version="2.0" IssueInstant="${iso(now)}" Destination="${xmlEscape(acsUrl)}"` +
    `${inResponseTo ? ` InResponseTo="${xmlEscape(inResponseTo)}"` : ''}>` +
    `<saml:Issuer>${xmlEscape(SAML_ISSUER)}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    signedAssertion +
    `</samlp:Response>`;

  return Buffer.from(response, 'utf8').toString('base64');
}

// --- OIDC (#1929 is not shipped yet; the endpoints are ready for it) --------

const OIDC_KID = 'e2e-stub-idp-1';
const b64url = (input) =>
  Buffer.from(typeof input === 'string' ? input : JSON.stringify(input)).toString('base64url');

export const OIDC_MODES = ['ok', 'wrong-key', 'wrong-aud', 'wrong-nonce', 'expired'];

function jwks() {
  return {
    keys: [
      { ...signing.publicKey.export({ format: 'jwk' }), kid: OIDC_KID, use: 'sig', alg: 'RS256' },
    ],
  };
}

export function buildIdToken({ audience, email, name, nonce, mode = 'ok' }) {
  const nowSec = Math.floor(Date.now() / 1000);
  const key = mode === 'wrong-key' ? rogue : signing;
  const header = { alg: 'RS256', typ: 'JWT', kid: OIDC_KID };
  const payload = {
    iss: OIDC_ISSUER,
    sub: `stub|${email}`,
    aud: mode === 'wrong-aud' ? 'some-other-client-id' : audience,
    exp: mode === 'expired' ? nowSec - 300 : nowSec + 300,
    iat: nowSec - 5,
    email,
    email_verified: true,
    name: name || email,
    ...(nonce ? { nonce: mode === 'wrong-nonce' ? `${nonce}-tampered` : nonce } : {}),
  };
  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  const signature = crypto
    .sign('sha256', Buffer.from(signingInput), key.privateKey)
    .toString('base64url');
  return `${signingInput}.${signature}`;
}

// Authorization codes issued by /oidc/authorize, consumed once by /oidc/token.
const oidcCodes = new Map();

// --- HTTP -----------------------------------------------------------------

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function html(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// The browser cannot be told to POST; an IdP answers the redirect binding with
// a self-submitting form. This is the real HTTP-POST binding, so the app's ACS
// sees exactly the request shape a production IdP sends.
function autoPostForm(acsUrl, samlResponse, relayState) {
  return `<!doctype html><html><head><title>Stub IdP</title></head>
<body onload="document.forms[0].submit()">
<p>Signing in via the stub IdP…</p>
<form method="post" action="${xmlEscape(acsUrl)}">
<input type="hidden" name="SAMLResponse" value="${xmlEscape(samlResponse)}"/>
${relayState ? `<input type="hidden" name="RelayState" value="${xmlEscape(relayState)}"/>` : ''}
<noscript><button type="submit">Continue</button></noscript>
</form>
</body></html>`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const q = url.searchParams;

  // Readiness probe for Playwright's webServer AND the handoff the spec reads:
  // it stores `samlCertificate` on the tenant the way a customer pastes theirs.
  if (url.pathname === '/__state') {
    return json(res, 200, {
      samlIssuer: SAML_ISSUER,
      samlSsoUrl: `${ORIGIN}/saml/sso`,
      samlCertificate: signing.certificate,
      // The certificate for a key the app must NOT trust — handed over so a
      // spec can prove that trusting the wrong certificate fails closed.
      rogueCertificate: rogue.certificate,
      oidcIssuer: OIDC_ISSUER,
      oidcDiscoveryUrl: `${OIDC_ISSUER}/.well-known/openid-configuration`,
      samlModes: SAML_MODES,
      oidcModes: OIDC_MODES,
    });
  }

  // --- SAML: the redirect binding the app's login route sends the browser to.
  if (url.pathname === '/saml/sso') {
    const samlRequest = q.get('SAMLRequest');
    if (!samlRequest) return json(res, 400, { error: 'SAMLRequest is required' });
    let parsed;
    try {
      parsed = parseAuthnRequest(samlRequest);
    } catch {
      return json(res, 400, { error: 'SAMLRequest could not be inflated' });
    }
    if (!parsed.acsUrl || !parsed.spEntityId) {
      return json(res, 400, { error: 'AuthnRequest lacks an ACS URL or Issuer' });
    }
    const samlResponse = buildSamlResponse({
      acsUrl: parsed.acsUrl,
      audience: parsed.spEntityId,
      email: q.get('email') || 'stub.user@e2e.local',
      name: q.get('name') || 'Stub User',
      mode: q.get('mode') || 'ok',
      inResponseTo: parsed.requestId,
    });
    return html(res, 200, autoPostForm(parsed.acsUrl, samlResponse, q.get('RelayState') || ''));
  }

  // --- SAML: mint a response for an AuthnRequest the spec captured itself, so
  // a negative case can be posted straight at the ACS without a browser hop.
  if (url.pathname === '/saml/mint' && req.method === 'POST') {
    let body;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      return json(res, 400, { error: 'body must be JSON' });
    }
    let acsUrl = body.acsUrl;
    let audience = body.audience;
    let inResponseTo = body.inResponseTo;
    if (body.samlRequest) {
      const parsed = parseAuthnRequest(body.samlRequest);
      acsUrl = acsUrl || parsed.acsUrl;
      audience = audience || parsed.spEntityId;
      inResponseTo = inResponseTo || parsed.requestId;
    }
    if (!acsUrl || !audience) {
      return json(res, 400, { error: 'acsUrl and audience (or samlRequest) are required' });
    }
    return json(res, 200, {
      SAMLResponse: buildSamlResponse({
        acsUrl,
        audience,
        email: body.email || 'stub.user@e2e.local',
        name: body.name || 'Stub User',
        mode: body.mode || 'ok',
        inResponseTo,
      }),
    });
  }

  // --- OIDC ---------------------------------------------------------------
  if (url.pathname.endsWith('/.well-known/openid-configuration')) {
    return json(res, 200, {
      issuer: OIDC_ISSUER,
      authorization_endpoint: `${OIDC_ISSUER}/authorize`,
      token_endpoint: `${OIDC_ISSUER}/token`,
      jwks_uri: `${OIDC_ISSUER}/jwks.json`,
      userinfo_endpoint: `${OIDC_ISSUER}/userinfo`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: ['openid', 'email', 'profile'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'nonce', 'email', 'email_verified', 'name'],
    });
  }

  if (url.pathname === '/oidc/jwks.json') return json(res, 200, jwks());

  if (url.pathname === '/oidc/authorize') {
    const redirectUri = q.get('redirect_uri');
    if (!redirectUri) return json(res, 400, { error: 'redirect_uri is required' });
    const code = crypto.randomBytes(24).toString('hex');
    oidcCodes.set(code, {
      audience: q.get('client_id') || 'e2e-oidc-client',
      nonce: q.get('nonce') || '',
      email: q.get('email') || 'stub.user@e2e.local',
      name: q.get('name') || 'Stub User',
      mode: q.get('mode') || 'ok',
    });
    const back = new URL(redirectUri);
    back.searchParams.set('code', code);
    const state = q.get('state');
    if (state) back.searchParams.set('state', state);
    res.writeHead(302, { Location: back.toString(), 'Cache-Control': 'no-store' });
    return res.end();
  }

  if (url.pathname === '/oidc/token' && req.method === 'POST') {
    const params = new URLSearchParams(await readBody(req));
    const code = params.get('code');
    const issued = code ? oidcCodes.get(code) : null;
    // Single use: a replayed code is invalid_grant, as at a real provider.
    if (!issued) return json(res, 400, { error: 'invalid_grant' });
    oidcCodes.delete(code);
    const audience = params.get('client_id') || issued.audience;
    return json(res, 200, {
      access_token: `stub-access-${crypto.randomBytes(8).toString('hex')}`,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'openid email profile',
      id_token: buildIdToken({
        audience,
        email: issued.email,
        name: issued.name,
        nonce: issued.nonce,
        mode: issued.mode,
      }),
    });
  }

  if (url.pathname === '/oidc/userinfo') {
    return json(res, 200, { sub: 'stub|stub.user@e2e.local', email: 'stub.user@e2e.local' });
  }

  json(res, 404, { error: 'not found' });
});

// Importable for a unit-style check of the builders without a listening socket.
if (!process.env.IDP_MOCK_NO_LISTEN) {
  // Loopback only: this process will sign an assertion for any audience it is
  // asked to, which is exactly what makes it useful and exactly why it must not
  // be reachable from off the machine.
  server.listen(PORT, '127.0.0.1', () => console.log(`idp-mock listening on ${PORT}`));
}

export { server, SAML_ISSUER, OIDC_ISSUER, ORIGIN };
