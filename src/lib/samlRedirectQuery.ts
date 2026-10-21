// The SAML HTTP-Redirect binding's query string, read the one way that keeps
// the signed bytes and the parsed message the same bytes (#1952 follow-up).
//
// THE BUG THIS CLOSES. node-saml verifies a redirect signature over the query
// it is handed, picking each parameter with a substring regex over the raw
// tokens and taking the FIRST match. The SLO route used to build the message
// it parses with `Object.fromEntries(url.searchParams)`, which keeps the LAST
// value of a repeated key. So one genuine signed LogoutRequest, with a second
// `SAMLRequest=` appended naming somebody else, verified against the first and
// acted on the second: a forged logout of any user in the org.
//
// THE RULE. Each of the five binding parameters may appear at most once, under
// its exact name (SAMLRequest/SAMLResponse exactly one of the two); anything
// else is refused. The canonical query handed to node-saml is rebuilt from
// those same raw tokens, in the binding's order, and the message node-saml
// parses is decoded from them too — one source for both.
//
// Pure and dependency-free; unit-tested in scripts/test/saml-redirect-query.test.mjs.

const KEYS = ['SAMLRequest', 'SAMLResponse', 'RelayState', 'SigAlg', 'Signature'] as const;
type Key = (typeof KEYS)[number];

export interface RedirectBindingQuery {
  /** Decoded values, exactly one per present key. */
  message: Partial<Record<Key, string>>;
  /** The raw (still-encoded) tokens, canonical order — what node-saml verifies. */
  canonicalQuery: string;
}

export type RedirectBindingRefusal = 'duplicate_param' | 'malformed' | 'no_message';

function decode(v: string): string | null {
  try {
    return decodeURIComponent(v.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

export function parseRedirectBinding(rawQuery: string): RedirectBindingQuery | RedirectBindingRefusal {
  const raw = new Map<Key, string>();
  for (const token of rawQuery.replace(/^\?/, '').split('&')) {
    if (!token) continue;
    const eq = token.indexOf('=');
    const name = decode(eq === -1 ? token : token.slice(0, eq));
    if (name === null) return 'malformed';
    if (!(KEYS as readonly string[]).includes(name)) continue; // not ours to read
    if (raw.has(name as Key)) return 'duplicate_param';
    raw.set(name as Key, token);
  }
  if (raw.has('SAMLRequest') === raw.has('SAMLResponse')) return 'no_message';

  const message: Partial<Record<Key, string>> = {};
  const tokens: string[] = [];
  for (const key of KEYS) {
    const token = raw.get(key);
    if (token === undefined) continue;
    const eq = token.indexOf('=');
    const value = decode(eq === -1 ? '' : token.slice(eq + 1));
    if (value === null) return 'malformed';
    message[key] = value;
    tokens.push(token);
  }
  return { message, canonicalQuery: tokens.join('&') };
}
