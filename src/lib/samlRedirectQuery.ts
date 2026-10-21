// The SAML HTTP-Redirect binding, read so that what is VERIFIED and what is
// PROCESSED are the same bytes (#1952 follow-up). Dependency-free; unit-tested
// in e2e/saml-redirect-query.unit.spec.ts.
//
// The signature of a Redirect message covers raw query tokens
// (`SAMLRequest=…&RelayState=…&SigAlg=…`), not decoded values. node-saml 5's
// `validateRedirectAsync(container, originalQuery)` takes both halves from the
// caller and never checks that they agree: it signs over the FIRST raw token
// whose text merely contains the key name, while it parses whatever the
// container says. A container built with URLSearchParams decodes keys and keeps
// the LAST of a repeated key, so a query carrying a genuinely signed message
// next to a second, unsigned one (repeated, or with a percent-encoded key such
// as `SAMLReq%75est`) verified the first and acted on the second.
//
// So the query is read here, once, token by token: each of the five binding
// keys may appear at most once and only spelled literally, a message is a
// request OR a response, and the query handed to node-saml is rebuilt from
// exactly the tokens the message was decoded from, in the binding's order.
// Every other parameter is dropped — the signature never covers one.

export const SAML_REDIRECT_KEYS = ['SAMLRequest', 'SAMLResponse', 'RelayState', 'SigAlg', 'Signature'] as const;
type RedirectKey = (typeof SAML_REDIRECT_KEYS)[number];

export type SamlRedirectMessage = Partial<Record<RedirectKey, string>>;

export type ParsedSamlRedirect =
  | { ok: true; msg: SamlRedirectMessage; signedQuery: string }
  | { ok: false; reason: 'duplicate_key' | 'encoded_key' | 'request_and_response' | 'malformed' };

const isRedirectKey = (k: string): k is RedirectKey => (SAML_REDIRECT_KEYS as readonly string[]).includes(k);

// application/x-www-form-urlencoded: `+` is a space, then percent-decoding.
// Strict where URLSearchParams is lenient: a broken escape is a refusal.
function formDecode(s: string): string | null {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

export function parseSamlRedirectQuery(rawQuery: string): ParsedSamlRedirect {
  const tokens: Partial<Record<RedirectKey, string>> = {};
  const msg: SamlRedirectMessage = {};
  for (const token of rawQuery.replace(/^\?/, '').split('&')) {
    if (!token) continue;
    const eq = token.indexOf('=');
    const rawKey = eq === -1 ? token : token.slice(0, eq);
    const key = formDecode(rawKey);
    if (key === null) return { ok: false, reason: 'malformed' };
    if (!isRedirectKey(key)) continue;
    if (rawKey !== key) return { ok: false, reason: 'encoded_key' };
    if (tokens[key] !== undefined) return { ok: false, reason: 'duplicate_key' };
    const value = formDecode(eq === -1 ? '' : token.slice(eq + 1));
    if (value === null) return { ok: false, reason: 'malformed' };
    tokens[key] = token;
    msg[key] = value;
  }
  if (tokens.SAMLRequest !== undefined && tokens.SAMLResponse !== undefined) {
    return { ok: false, reason: 'request_and_response' };
  }
  const signedQuery = [tokens.SAMLRequest ?? tokens.SAMLResponse, tokens.RelayState, tokens.SigAlg, tokens.Signature]
    .filter((t): t is string => t !== undefined)
    .join('&');
  return { ok: true, msg, signedQuery };
}
