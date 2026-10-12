// Database observability (#1608): the threshold parsing, the per-request
// counter and the rule that a query's params never reach a log line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
register('./ts-extensionless-resolve.mjs', import.meta.url);

const {
  parseSlowQueryMs,
  parseQueryCeiling,
  topModels,
  DEFAULT_DEV_SLOW_QUERY_MS,
  DEFAULT_QUERY_CEILING,
} = await import('../../src/lib/dbQueryObserver.ts');

test('slow-query logging is off in production until a threshold is set', () => {
  assert.equal(parseSlowQueryMs(undefined, 'production'), null);
  assert.equal(parseSlowQueryMs('', 'production'), null);
  assert.equal(parseSlowQueryMs('250', 'production'), 250);
  assert.equal(parseSlowQueryMs(undefined, 'development'), DEFAULT_DEV_SLOW_QUERY_MS);
  assert.equal(parseSlowQueryMs('0', 'development'), null, '0 switches it off explicitly');
  assert.equal(parseSlowQueryMs('nope', 'development'), null);
});

test('the per-request ceiling falls back to its default on nonsense', () => {
  assert.equal(parseQueryCeiling(undefined), DEFAULT_QUERY_CEILING);
  assert.equal(parseQueryCeiling('0'), DEFAULT_QUERY_CEILING);
  assert.equal(parseQueryCeiling('-3'), DEFAULT_QUERY_CEILING);
  assert.equal(parseQueryCeiling('120'), 120);
});

test('the warning names the top models by count, ties alphabetically', () => {
  const m = new Map([['User', 4], ['Message', 31], ['Conversation', 4], ['Goal', 1]]);
  assert.equal(topModels(m), 'Message×31, Conversation×4, User×4');
  assert.equal(topModels(new Map()), '');
});

test('the observer and the timing middleware never touch query params or args', () => {
  // Static, because the rule is about what the code can reach, not what one
  // run happened to log: params carry e-mail addresses, names and bodies.
  const observer = readFileSync(new URL('../../src/lib/dbQueryObserver.ts', import.meta.url), 'utf8');
  const prisma = readFileSync(new URL('../../src/lib/prisma.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(observer, /\bargs\b/);
  const hook = prisma.slice(prisma.indexOf('observable[OBSERVED] = true'));
  assert.match(hook, /observeQuery\(params\.model, params\.action, /);
  assert.doesNotMatch(hook, /params\.args/);
});

test('a request counts its queries, warns once past the ceiling and reports the count outside production', async () => {
  process.env.DB_QUERY_WARN_CEILING = '2';
  const { withRequestScope, currentQueryCount } = await import('../../src/lib/requestContext.ts');
  const { ambientCountQuery } = await import('../../src/lib/requestId.ts');
  const warnings = [];
  const original = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const res = await withRequestScope(new Headers(), async () => {
      for (const m of ['User', 'User', 'Message', 'User']) ambientCountQuery(m);
      assert.equal(currentQueryCount(), 4);
      return new Response('ok');
    });
    assert.equal(res.headers.get('x-db-queries'), '4');
    const ceiling = warnings.filter((w) => w.includes('query ceiling'));
    assert.equal(ceiling.length, 1, 'one warning per request, not one per query past the ceiling');
    // Fired at the moment the ceiling was crossed (the 3rd query), with the
    // request id the logger stamps on every line.
    assert.match(ceiling[0], /"queries":3,"top":"User×2, Message×1"/);
    assert.match(ceiling[0], /"requestId":"[0-9a-f-]{36}"/);
    // Outside a request there is nothing to count against, and nothing throws.
    ambientCountQuery('User');
    assert.equal(currentQueryCount(), undefined);
  } finally {
    console.warn = original;
  }
});
