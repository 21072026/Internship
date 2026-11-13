// The browser's zod config (src/lib/zodBrowserConfig.ts, #3642): with it, a parse
// never calls `new Function` — the probe the strict report-only CSP reports as a
// violation on every page that validates anything. Without it, zod probes.
//
// Each test file runs in its own process, so zod's cached probe starts fresh here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { z } = await import('zod');
const { installBrowserZodConfig } = await import('../../src/lib/zodBrowserConfig.ts');

/** Runs `fn` with the global Function constructor replaced by a counting stand-in. */
function countingFunctionCalls(fn) {
  const real = globalThis.Function;
  let calls = 0;
  globalThis.Function = function (...args) {
    calls += 1;
    return real(...args);
  };
  try {
    fn();
  } finally {
    globalThis.Function = real;
  }
  return calls;
}

test('installed, zod parses without ever calling new Function', () => {
  installBrowserZodConfig();
  assert.equal(z.config().jitless, true);
  const schema = z.object({ email: z.string().email(), password: z.string().min(8), remember: z.boolean().optional() });
  const calls = countingFunctionCalls(() => {
    for (let i = 0; i < 5; i++) schema.safeParse({ email: 'a@example.com', password: 'x'.repeat(8) });
    assert.equal(schema.safeParse({ email: 'nope', password: 'short' }).success, false);
  });
  assert.equal(calls, 0);
});
