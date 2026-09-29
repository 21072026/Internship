// Unit tests for the WRONG_WORLD sign-in error codes (src/lib/authErrors.ts, #2590).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// WHY THESE ARE UNIT TESTS AND NOT A BROWSER TEST
//   `authorize()` answers "right password, but this account lives in the OTHER
//   world" with `throw new Error(authWrongWorld(world))`, and NextAuth hands that
//   message to the browser verbatim as `?error=…`. Three things have to hold for
//   the sign-in page to point at the right door instead of saying "invalid", and
//   none of them is visible from the type system:
//
//     • THE CODE ROUND-TRIPS. `parseWrongWorld(authWrongWorld(k)) === k` for every
//       vertical the catalogue has, so a third product added to VERTICALS is
//       covered without anyone touching this file;
//     • THE PARSER IS STRICT. It runs on a string the browser carries in a URL, so
//       a prefix with no key, an unknown key or a differently-cased key is "not a
//       wrong-world error" — never a guess at one;
//     • THE CODE SURVIVES `guardProviders`. The guard replaces every error that is
//       not on the INTENTIONAL_AUTH_ERRORS allow-list with UNEXPECTED_ERROR, and
//       says nothing about it. A wrong-world code missing from that set would
//       compile, pass every test that calls authorize() directly, and reach the
//       user as "something went wrong" — the exact failure this feature exists to
//       replace.
//
//   authGuard.ts imports only the logger and authErrors (no Prisma, no NextAuth
//   runtime), so the last property is tested through the real guard.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// authErrors.ts imports `@/lib/verticals` and authGuard.ts `@/lib/logger` — an
// alias Node's ESM resolver does not know. The hook must be installed before
// they load, hence the dynamic imports.
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const {
  authWrongWorld,
  parseWrongWorld,
  INTENTIONAL_AUTH_ERRORS,
  AUTH_UNEXPECTED_ERROR,
  AUTH_SERVICE_UNAVAILABLE,
  AUTH_SSO_REQUIRED,
} = await import('../../src/lib/authErrors.ts');
const { guardProviders } = await import('../../src/lib/authGuard.ts');
const { VERTICAL_KEYS } = await import('../../src/lib/verticals.ts');

const PREFIX = 'WRONG_WORLD_';

test('the catalogue has at least the two worlds this feature is about', () => {
  // If this ever fails the round-trip tests below still pass, vacuously; say so.
  assert.ok(VERTICAL_KEYS.includes('INTERNSHIP'));
  assert.ok(VERTICAL_KEYS.includes('MARKETING'));
});

test('authWrongWorld: the wire format is WRONG_WORLD_<VERTICAL> — the sign-in page keys off this text', () => {
  assert.equal(authWrongWorld('INTERNSHIP'), 'WRONG_WORLD_INTERNSHIP');
  assert.equal(authWrongWorld('MARKETING'), 'WRONG_WORLD_MARKETING');
  for (const key of VERTICAL_KEYS) assert.equal(authWrongWorld(key), `${PREFIX}${key}`);
});

test('authWrongWorld/parseWrongWorld round-trip for every vertical in the catalogue', () => {
  for (const key of VERTICAL_KEYS) {
    assert.equal(parseWrongWorld(authWrongWorld(key)), key, key);
  }
});

test('parseWrongWorld: a null, undefined or empty error is not a wrong-world error', () => {
  assert.equal(parseWrongWorld(null), null);
  assert.equal(parseWrongWorld(undefined), null);
  assert.equal(parseWrongWorld(''), null);
});

test('parseWrongWorld: the prefix alone is not a wrong-world error', () => {
  assert.equal(parseWrongWorld(PREFIX), null);
  assert.equal(parseWrongWorld('WRONG_WORLD'), null);
});

test('parseWrongWorld: an unknown vertical is null, never a guess', () => {
  for (const key of ['BOGUS', 'FINANCE', '0', 'null', 'undefined', 'INTERNSHIPS', 'MARKETING2']) {
    assert.equal(parseWrongWorld(`${PREFIX}${key}`), null, key);
  }
});

test('parseWrongWorld: the key is matched exactly — case, padding and suffixes do not pass', () => {
  for (const bad of [
    'WRONG_WORLD_marketing',
    'WRONG_WORLD_Marketing',
    'wrong_world_MARKETING',
    ' WRONG_WORLD_MARKETING',
    'WRONG_WORLD_MARKETING ',
    'WRONG_WORLD_MARKETING\n',
    'WRONG_WORLD_MARKETING_EXTRA',
    'WRONG_WORLD_MARKETING,WRONG_WORLD_INTERNSHIP',
    'XWRONG_WORLD_MARKETING',
    'MARKETING',
    'INTERNSHIP',
  ]) {
    assert.equal(parseWrongWorld(bad), null, JSON.stringify(bad));
  }
});

test('parseWrongWorld: property names of Object.prototype are not verticals', () => {
  for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.equal(parseWrongWorld(`${PREFIX}${key}`), null, key);
  }
});

test('parseWrongWorld: every OTHER sign-in error is null', () => {
  for (const other of INTENTIONAL_AUTH_ERRORS) {
    if (other.startsWith(PREFIX)) continue;
    assert.equal(parseWrongWorld(other), null, other);
  }
  for (const other of [AUTH_UNEXPECTED_ERROR, AUTH_SERVICE_UNAVAILABLE, AUTH_SSO_REQUIRED, 'CredentialsSignin']) {
    assert.equal(parseWrongWorld(other), null, other);
  }
});

test('INTENTIONAL_AUTH_ERRORS holds the wrong-world code of EVERY vertical (so the guard does not swallow it)', () => {
  for (const key of VERTICAL_KEYS) {
    assert.ok(INTENTIONAL_AUTH_ERRORS.has(authWrongWorld(key)), authWrongWorld(key));
  }
});

test('INTENTIONAL_AUTH_ERRORS holds no wrong-world code that parseWrongWorld would reject', () => {
  // The set is an allow-list in both directions (the sign-in page renders only
  // what is in it). A WRONG_WORLD_* entry the parser cannot read would be
  // rendered as a raw code instead of a link to the right door.
  const worldCodes = [...INTENTIONAL_AUTH_ERRORS].filter((e) => e.startsWith(PREFIX));
  assert.deepEqual(worldCodes.sort(), VERTICAL_KEYS.map(authWrongWorld).sort());
  for (const code of worldCodes) assert.notEqual(parseWrongWorld(code), null, code);
});

test('the wrong-world codes are distinct from the fault codes the guard substitutes', () => {
  for (const key of VERTICAL_KEYS) {
    assert.notEqual(authWrongWorld(key), AUTH_UNEXPECTED_ERROR);
    assert.notEqual(authWrongWorld(key), AUTH_SERVICE_UNAVAILABLE);
  }
});

// ── through the real guard ───────────────────────────────────────────────────

/**
 * A provider shaped like CredentialsProvider({ … }): a stub `authorize` on top
 * and the real one inside `options`, which NextAuth merges back OVER the top
 * level (see e2e/auth-error-guard.unit.spec.ts for why that decides which runs).
 */
function providerThrowing(thrown) {
  const authorize = async () => {
    throw thrown;
  };
  return { id: 'credentials', authorize: () => null, options: { id: 'credentials', authorize } };
}
function effectiveAuthorize(provider) {
  const merged = { ...provider, ...(provider.options ?? {}) };
  return () => merged.authorize({}, {});
}
function guarded(thrown) {
  return effectiveAuthorize(guardProviders([providerThrowing(thrown)])[0]);
}

test('guardProviders passes a WRONG_WORLD_* error through untouched, and logs nothing', async () => {
  const errorLog = mock.method(console, 'error', () => {});
  try {
    for (const key of VERTICAL_KEYS) {
      const original = new Error(authWrongWorld(key));
      await assert.rejects(guarded(original)(), (caught) => {
        assert.equal(caught, original, 'the very same Error, not a copy');
        assert.equal(caught.message, authWrongWorld(key));
        return true;
      });
    }
    assert.equal(errorLog.mock.callCount(), 0, 'an intentional refusal is not a server fault');
  } finally {
    errorLog.mock.restore();
  }
});

test('guardProviders keeps a wrong-world code that arrives as a thrown string', async () => {
  await assert.rejects(guarded(authWrongWorld('MARKETING'))(), { message: 'WRONG_WORLD_MARKETING' });
});

test('guardProviders still replaces an unknown WRONG_WORLD_* code with UNEXPECTED_ERROR', async () => {
  // The allow-list is exact: only the codes the catalogue mints get through, so
  // this feature is not a way to put arbitrary text on the login form.
  const errorLog = mock.method(console, 'error', () => {});
  try {
    await assert.rejects(guarded(new Error(`${PREFIX}BOGUS`))(), { message: AUTH_UNEXPECTED_ERROR });
    await assert.rejects(guarded(new Error(PREFIX))(), { message: AUTH_UNEXPECTED_ERROR });
    assert.equal(errorLog.mock.callCount(), 2, 'each of those IS a fault and is logged');
  } finally {
    errorLog.mock.restore();
  }
});

test('guardProviders guards the top-level authorize as well as the one inside options', async () => {
  const top = { id: 'x', authorize: async () => { throw new Error(authWrongWorld('MARKETING')); } };
  const [wrapped] = guardProviders([top]);
  await assert.rejects(wrapped.authorize({}, {}), { message: 'WRONG_WORLD_MARKETING' });
});
