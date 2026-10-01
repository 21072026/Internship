// Unit tests for the host → WORLD rule (src/lib/hostWorld.ts, #2590).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// WHY THESE ARE UNIT TESTS AND NOT A BROWSER TEST
//   The rule is one sentence the maintainer stated — "the URL you sign in on
//   decides which application you are using" — and every property that makes it
//   safe typechecks perfectly while being wrong:
//
//     • THE HOST MAY CHOOSE OR REFUSE, NEVER WIDEN. A look-alike name
//       (`marketing.bcsit-gmbh.de.evil.example`) or a proxy list whose FIRST entry
//       is not ours must not read as a marketing host, or a forged header would
//       sign somebody into a world it was not theirs to pick;
//     • PRECEDENCE. The proxy's X-Forwarded-Host is the one Caddy overwrites; Host
//       is what the client typed. Swapping them is a one-token diff that no
//       compiler sees;
//     • THE E-MAIL LINK MUST OPEN THE RIGHT PRODUCT. `originForWorld` is what every
//       mail builder appends a path to. INTERNSHIP has to stay byte-identical to
//       the origin every builder used before (rule 5 of the worlds spec), and the
//       MARKETING origin has to be a host that `worldForHostHeader` maps BACK to
//       MARKETING — a link that opens the other product is the bug this whole
//       epic exists to remove.
//
//   The module is pure, so no database, no server and no browser: about a second.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// hostWorld.ts imports './servedHosts' and './verticals' without an extension —
// the bundler resolves that, Node's ESM resolver does not. The hook has to be
// installed before the module loads, hence the dynamic import.
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const {
  worldForHostHeader,
  worldForHeaders,
  worldForHeaderBag,
  primaryMarketingHost,
  originForWorld,
} = await import('../../src/lib/hostWorld.ts');
const { VERTICAL_KEYS, DEFAULT_VERTICAL } = await import('../../src/lib/verticals.ts');

const ENV = ['NEXTAUTH_URL', 'NEXT_PUBLIC_APP_URL', 'MARKETING_HOSTS'];
const ORIGINAL = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
function setEnv(vars) {
  for (const k of ENV) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
}
beforeEach(() => setEnv({}));
after(() => {
  for (const k of ENV) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k];
  }
});

// The production marketing host, spelled out on purpose: it is the one literal
// these tests are about (`marketing.bcsit-gmbh.de` is the live site, #2540).
const MKT = 'marketing.bcsit-gmbh.de';

// ── worldForHostHeader ───────────────────────────────────────────────────────

test('worldForHostHeader: the marketing host is MARKETING, anything else is INTERNSHIP', () => {
  assert.equal(worldForHostHeader(MKT), 'MARKETING');
  assert.equal(worldForHostHeader('interncrm.com'), 'INTERNSHIP');
  assert.equal(worldForHostHeader('preview.interncrm.com'), 'INTERNSHIP');
  assert.equal(worldForHostHeader('localhost'), 'INTERNSHIP');
});

test('worldForHostHeader: an unknown host is the DEFAULT world, never an error and never a third one', () => {
  for (const h of ['pr123.interncrm.com', 'evil.example', '203.0.113.7', '[::1]:3000']) {
    assert.equal(worldForHostHeader(h), DEFAULT_VERTICAL, h);
  }
  assert.ok(VERTICAL_KEYS.includes(worldForHostHeader('who.knows.example')));
});

test('worldForHostHeader: a missing, empty or unparsable header is the default world', () => {
  for (const h of [undefined, null, '', '   ', ',', ':3000', ' , marketing.bcsit-gmbh.de']) {
    assert.equal(worldForHostHeader(h), 'INTERNSHIP', JSON.stringify(h));
  }
});

test('worldForHostHeader: a port is dropped before the comparison', () => {
  assert.equal(worldForHostHeader(`${MKT}:443`), 'MARKETING');
  assert.equal(worldForHostHeader(`${MKT}:3000`), 'MARKETING');
  assert.equal(worldForHostHeader('interncrm.com:443'), 'INTERNSHIP');
});

test('worldForHostHeader: host names are case-insensitive', () => {
  assert.equal(worldForHostHeader('Marketing.BCSIT-GmbH.de'), 'MARKETING');
  assert.equal(worldForHostHeader('MARKETING.BCSIT-GMBH.DE:443'), 'MARKETING');
});

test('worldForHostHeader: only the FIRST entry of a proxy list counts', () => {
  // The first entry is the client's; a later one is a hop's. A list that merely
  // MENTIONS the marketing host somewhere must not turn into the marketing world.
  assert.equal(worldForHostHeader(`${MKT}, interncrm.com`), 'MARKETING');
  assert.equal(worldForHostHeader(` ${MKT}:443 , evil.example`), 'MARKETING');
  assert.equal(worldForHostHeader(`interncrm.com, ${MKT}`), 'INTERNSHIP');
  assert.equal(worldForHostHeader(`evil.example,${MKT}`), 'INTERNSHIP');
});

test('worldForHostHeader: a look-alike name is not the marketing host (exact match, no suffix or prefix rule)', () => {
  // The host may PICK one of a person's own accounts and may REFUSE; it must never
  // widen access. An exact-match set is what keeps a forged name from choosing a
  // world it does not belong to.
  for (const h of [
    `${MKT}.evil.example`,
    `evil-${MKT}`,
    `x.${MKT}`,
    `${MKT}@evil.example`,
    `evil.example/${MKT}`,
    'bcsit-gmbh.de',
    'marketing',
  ]) {
    assert.equal(worldForHostHeader(h), 'INTERNSHIP', h);
  }
});

test('worldForHostHeader: MARKETING_HOSTS replaces the default, it does not add to it', () => {
  setEnv({ MARKETING_HOSTS: 'marketing.bcsit-gmbh.dev' });
  assert.equal(worldForHostHeader('marketing.bcsit-gmbh.dev'), 'MARKETING');
  assert.equal(worldForHostHeader(MKT), 'INTERNSHIP', 'the default is replaced, not merged');
});

test('worldForHostHeader: every entry of a multi-host MARKETING_HOSTS is a marketing host', () => {
  setEnv({ MARKETING_HOSTS: ' Marketing.A.example:443, b.example ,, ' });
  assert.equal(worldForHostHeader('marketing.a.example'), 'MARKETING');
  assert.equal(worldForHostHeader('b.example:8080'), 'MARKETING');
  assert.equal(worldForHostHeader('c.example'), 'INTERNSHIP');
});

test('worldForHostHeader: an EMPTY or whitespace MARKETING_HOSTS is "unset" — prod configures nothing (#2428)', () => {
  for (const raw of ['', '   ', '\n']) {
    setEnv({ MARKETING_HOSTS: raw });
    assert.equal(worldForHostHeader(MKT), 'MARKETING', JSON.stringify(raw));
    assert.equal(worldForHostHeader('interncrm.com'), 'INTERNSHIP', JSON.stringify(raw));
  }
});

// ── worldForHeaders ──────────────────────────────────────────────────────────

/** A header accessor over a plain object, the shape `headers().get` has. */
const getterOf = (rec) => (name) => rec[name];

test('worldForHeaders: X-Forwarded-Host beats Host, in both directions', () => {
  // Caddy overwrites x-forwarded-host with the host it accepted; Host is what the
  // client claims. The proxy's word wins — swapping the two reads the client's.
  assert.equal(
    worldForHeaders(getterOf({ 'x-forwarded-host': MKT, host: 'interncrm.com' })),
    'MARKETING',
  );
  assert.equal(
    worldForHeaders(getterOf({ 'x-forwarded-host': 'interncrm.com', host: MKT })),
    'INTERNSHIP',
  );
});

test('worldForHeaders: Host is used when there is no X-Forwarded-Host (null and undefined alike)', () => {
  assert.equal(worldForHeaders(getterOf({ host: MKT })), 'MARKETING');
  assert.equal(worldForHeaders(() => null), 'INTERNSHIP');
  assert.equal(worldForHeaders((n) => (n === 'host' ? MKT : null)), 'MARKETING');
  assert.equal(worldForHeaders((n) => (n === 'host' ? `${MKT}:3000` : undefined)), 'MARKETING');
});

test('worldForHeaders: no header at all is the default world', () => {
  assert.equal(worldForHeaders(() => undefined), 'INTERNSHIP');
});

test('worldForHeaders: asks for the lower-case names the proxy sets', () => {
  const asked = [];
  worldForHeaders((n) => {
    asked.push(n);
    return null;
  });
  assert.deepEqual(asked, ['x-forwarded-host', 'host']);
});

// ── worldForHeaderBag ────────────────────────────────────────────────────────

test('worldForHeaderBag: a plain lower-cased record, the shape NextAuth hands authorize()', () => {
  assert.equal(worldForHeaderBag({ 'x-forwarded-host': MKT }), 'MARKETING');
  assert.equal(worldForHeaderBag({ host: MKT }), 'MARKETING');
  assert.equal(worldForHeaderBag({ host: 'interncrm.com' }), 'INTERNSHIP');
  assert.equal(worldForHeaderBag({ 'x-forwarded-host': `${MKT}:443`, host: 'interncrm.com' }), 'MARKETING');
  assert.equal(worldForHeaderBag({ 'x-forwarded-host': 'interncrm.com', host: MKT }), 'INTERNSHIP');
  assert.equal(worldForHeaderBag({}), 'INTERNSHIP');
});

test('worldForHeaderBag: an array value reads its first element (Node\'s repeated-header shape)', () => {
  assert.equal(worldForHeaderBag({ 'x-forwarded-host': [MKT, 'interncrm.com'] }), 'MARKETING');
  assert.equal(worldForHeaderBag({ 'x-forwarded-host': ['interncrm.com', MKT] }), 'INTERNSHIP');
  assert.equal(worldForHeaderBag({ host: [MKT] }), 'MARKETING');
  // An empty array is "no value", so Host is consulted — not a crash, not a guess.
  assert.equal(worldForHeaderBag({ 'x-forwarded-host': [], host: MKT }), 'MARKETING');
  assert.equal(worldForHeaderBag({ 'x-forwarded-host': [] }), 'INTERNSHIP');
});

test('worldForHeaderBag: undefined entries in a record are absent, not "internship"', () => {
  assert.equal(worldForHeaderBag({ 'x-forwarded-host': undefined, host: MKT }), 'MARKETING');
});

test('worldForHeaderBag: a real Headers works, and is case-insensitive by itself', () => {
  assert.equal(worldForHeaderBag(new Headers({ 'x-forwarded-host': MKT })), 'MARKETING');
  assert.equal(worldForHeaderBag(new Headers({ 'X-Forwarded-Host': MKT })), 'MARKETING');
  assert.equal(worldForHeaderBag(new Headers({ Host: MKT })), 'MARKETING');
  assert.equal(
    worldForHeaderBag(new Headers({ 'x-forwarded-host': 'interncrm.com', host: MKT })),
    'INTERNSHIP',
    'X-Forwarded-Host wins over Host on a Headers too',
  );
  assert.equal(worldForHeaderBag(new Headers()), 'INTERNSHIP');
});

test('worldForHeaderBag: null and undefined are the default world', () => {
  assert.equal(worldForHeaderBag(null), 'INTERNSHIP');
  assert.equal(worldForHeaderBag(undefined), 'INTERNSHIP');
});

test('worldForHeaderBag and worldForHeaders agree on the same request', () => {
  const requests = [
    { 'x-forwarded-host': MKT },
    { host: MKT },
    { 'x-forwarded-host': 'interncrm.com', host: MKT },
    { 'x-forwarded-host': MKT, host: 'interncrm.com' },
    { 'x-forwarded-host': `${MKT}.evil.example` },
    {},
  ];
  for (const rec of requests) {
    assert.equal(worldForHeaderBag(rec), worldForHeaders(getterOf(rec)), JSON.stringify(rec));
    assert.equal(
      worldForHeaderBag(new Headers(rec)),
      worldForHeaders(getterOf(rec)),
      `Headers ${JSON.stringify(rec)}`,
    );
  }
});

// ── primaryMarketingHost / originForWorld ────────────────────────────────────

test('primaryMarketingHost: the default host, or the FIRST MARKETING_HOSTS entry', () => {
  assert.equal(primaryMarketingHost(), MKT);
  setEnv({ MARKETING_HOSTS: 'Marketing.A.example:443, marketing.b.example' });
  assert.equal(primaryMarketingHost(), 'marketing.a.example');
  setEnv({ MARKETING_HOSTS: '' });
  assert.equal(primaryMarketingHost(), MKT);
});

test('originForWorld(INTERNSHIP): NEXT_PUBLIC_APP_URL, trailing slashes trimmed — what every mail builder used', () => {
  setEnv({ NEXT_PUBLIC_APP_URL: 'https://interncrm.com' });
  assert.equal(originForWorld('INTERNSHIP'), 'https://interncrm.com');
  setEnv({ NEXT_PUBLIC_APP_URL: 'https://interncrm.com/' });
  assert.equal(originForWorld('INTERNSHIP'), 'https://interncrm.com');
  setEnv({ NEXT_PUBLIC_APP_URL: 'https://interncrm.com///' });
  assert.equal(originForWorld('INTERNSHIP'), 'https://interncrm.com');
});

test('originForWorld(INTERNSHIP): NEXT_PUBLIC_APP_URL wins over NEXTAUTH_URL, which is the fallback', () => {
  setEnv({ NEXT_PUBLIC_APP_URL: 'https://interncrm.com', NEXTAUTH_URL: 'https://auth.example' });
  assert.equal(originForWorld('INTERNSHIP'), 'https://interncrm.com');
  setEnv({ NEXTAUTH_URL: 'https://preview.interncrm.com/' });
  assert.equal(originForWorld('INTERNSHIP'), 'https://preview.interncrm.com');
  // A blank NEXT_PUBLIC_APP_URL is unset, not an empty origin.
  setEnv({ NEXT_PUBLIC_APP_URL: '   ', NEXTAUTH_URL: 'https://preview.interncrm.com' });
  assert.equal(originForWorld('INTERNSHIP'), 'https://preview.interncrm.com');
  setEnv({ NEXT_PUBLIC_APP_URL: '', NEXTAUTH_URL: 'https://preview.interncrm.com' });
  assert.equal(originForWorld('INTERNSHIP'), 'https://preview.interncrm.com');
});

test('originForWorld(INTERNSHIP): nothing configured is the local dev origin', () => {
  assert.equal(originForWorld('INTERNSHIP'), 'http://localhost:3000');
});

test('originForWorld(INTERNSHIP): does not depend on MARKETING_HOSTS at all', () => {
  setEnv({ NEXT_PUBLIC_APP_URL: 'https://interncrm.com' });
  const before = originForWorld('INTERNSHIP');
  setEnv({ NEXT_PUBLIC_APP_URL: 'https://interncrm.com', MARKETING_HOSTS: 'a.example,b.example' });
  assert.equal(originForWorld('INTERNSHIP'), before);
});

test('originForWorld(MARKETING): the marketing host on the deployment\'s own https scheme', () => {
  setEnv({ NEXTAUTH_URL: 'https://interncrm.com', NEXT_PUBLIC_APP_URL: 'https://interncrm.com/' });
  assert.equal(originForWorld('MARKETING'), `https://${MKT}`);
});

test('originForWorld(MARKETING): the scheme is inherited from the deployment, not assumed', () => {
  setEnv({ NEXTAUTH_URL: 'https://preview.interncrm.com', MARKETING_HOSTS: 'marketing.bcsit-gmbh.dev' });
  assert.equal(originForWorld('MARKETING'), 'https://marketing.bcsit-gmbh.dev');
  setEnv({ NEXTAUTH_URL: 'http://staging.internal', MARKETING_HOSTS: 'marketing.staging.internal' });
  assert.equal(originForWorld('MARKETING'), 'http://marketing.staging.internal');
});

test('originForWorld(MARKETING): falls back to NEXT_PUBLIC_APP_URL for the scheme when NEXTAUTH_URL is unset', () => {
  setEnv({ NEXT_PUBLIC_APP_URL: 'https://interncrm.com/' });
  assert.equal(originForWorld('MARKETING'), `https://${MKT}`);
});

test('originForWorld(MARKETING): a real domain never inherits the deployment\'s port', () => {
  setEnv({ NEXTAUTH_URL: 'https://interncrm.com:8443' });
  assert.equal(originForWorld('MARKETING'), `https://${MKT}`);
  setEnv({ NEXTAUTH_URL: 'http://localhost:3000' });
  assert.equal(originForWorld('MARKETING'), `http://${MKT}`, 'the default marketing host is not localhost');
});

test('originForWorld(MARKETING): the port is re-attached ONLY when the marketing host IS the configured host', () => {
  // A developer's `localhost` serves both worlds; the port is what makes the link work.
  setEnv({ NEXTAUTH_URL: 'http://localhost:3000', MARKETING_HOSTS: 'localhost' });
  assert.equal(originForWorld('MARKETING'), 'http://localhost:3000');
  setEnv({ NEXTAUTH_URL: 'http://localhost:4010', MARKETING_HOSTS: 'localhost:4010' });
  assert.equal(originForWorld('MARKETING'), 'http://localhost:4010');
  // Same host, but the configured origin carries no port → nothing to re-attach.
  setEnv({ NEXTAUTH_URL: 'https://marketing.example', MARKETING_HOSTS: 'marketing.example' });
  assert.equal(originForWorld('MARKETING'), 'https://marketing.example');
  // The FIRST entry decides; a later entry equal to the configured host does not re-attach.
  setEnv({ NEXTAUTH_URL: 'http://localhost:3000', MARKETING_HOSTS: 'marketing.example,localhost' });
  assert.equal(originForWorld('MARKETING'), 'http://marketing.example');
});

test('originForWorld(MARKETING): a multi-entry MARKETING_HOSTS uses the FIRST entry as the primary', () => {
  setEnv({
    NEXTAUTH_URL: 'https://interncrm.com',
    MARKETING_HOSTS: ' Marketing.Primary.example:443 , marketing.second.example',
  });
  assert.equal(originForWorld('MARKETING'), 'https://marketing.primary.example');
});

test('originForWorld(MARKETING): an EMPTY MARKETING_HOSTS is the default host (#2428)', () => {
  for (const raw of ['', '  ']) {
    setEnv({ NEXTAUTH_URL: 'https://interncrm.com', MARKETING_HOSTS: raw });
    assert.equal(originForWorld('MARKETING'), `https://${MKT}`, JSON.stringify(raw));
  }
});

test('originForWorld: a trailing slash never leaks into either origin (a path is appended to it)', () => {
  setEnv({ NEXTAUTH_URL: 'https://interncrm.com/', NEXT_PUBLIC_APP_URL: 'https://interncrm.com/' });
  for (const w of VERTICAL_KEYS) {
    const o = originForWorld(w);
    assert.ok(!o.endsWith('/'), `${w}: ${o}`);
    assert.doesNotThrow(() => new URL(`${o}/auth/signin`), w);
  }
});

test('originForWorld: the two worlds get different origins on a normal deployment', () => {
  setEnv({ NEXTAUTH_URL: 'https://interncrm.com', NEXT_PUBLIC_APP_URL: 'https://interncrm.com' });
  assert.notEqual(originForWorld('INTERNSHIP'), originForWorld('MARKETING'));
});

// The property the whole epic rests on: an e-mail link built for a world must be
// a host that the host → world rule maps back to that same world. If either half
// drifts, a marketing person's password-reset link opens the internship product.
test('round trip: originForWorld(w) is a host that worldForHostHeader maps back to w', () => {
  const deployments = [
    {},
    { NEXTAUTH_URL: 'https://interncrm.com', NEXT_PUBLIC_APP_URL: 'https://interncrm.com/' },
    { NEXTAUTH_URL: 'https://preview.interncrm.com', MARKETING_HOSTS: 'marketing.bcsit-gmbh.dev' },
    { NEXTAUTH_URL: 'https://pr123.interncrm.com' },
    { NEXTAUTH_URL: 'http://localhost:3000', MARKETING_HOSTS: 'localhost' },
    { NEXTAUTH_URL: 'https://interncrm.com', MARKETING_HOSTS: 'Marketing.A.example:443, b.example' },
    { NEXTAUTH_URL: 'https://interncrm.com', MARKETING_HOSTS: '' },
  ];
  for (const env of deployments) {
    setEnv(env);
    for (const w of VERTICAL_KEYS) {
      if (w === 'INTERNSHIP' && env.MARKETING_HOSTS === 'localhost') continue; // one host, two worlds: dev only
      const url = new URL(originForWorld(w));
      assert.equal(worldForHostHeader(url.host), w, `${JSON.stringify(env)} → ${w} → ${url.host}`);
    }
  }
});
