// scripts/i18n-scopes.mjs writes src/i18n/scopes.generated.ts whole or not at
// all (#3958). Two unit tests regenerate the file while `node --test` runs
// files in parallel; an in-place write let one of them read the other's
// half-written file and fail with "the admin chrome scope is missing". This
// runs three generators at once and reads the file the whole time: every read
// must be a complete file.
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const FILE = 'src/i18n/scopes.generated.ts';

function generate() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/i18n-scopes.mjs'], { stdio: 'ignore' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`generator exited ${code}`))));
  });
}

test('concurrent generators never leave a half-written scopes file', async () => {
  await generate();
  let running = true;
  const runs = Promise.all([generate(), generate(), generate()]).finally(() => {
    running = false;
  });
  let reads = 0;
  while (running) {
    const text = readFileSync(FILE, 'utf8');
    reads += 1;
    assert.ok(text.includes('export const SHELL_NAMESPACES'), `read ${reads} is not a whole file (${text.length} bytes)`);
    assert.match(text, /^ {2}'admin': \[/m, `read ${reads} has no admin chrome scope`);
    await new Promise((r) => setImmediate(r));
  }
  await runs;
  assert.ok(reads > 0);
  // No temp file is left behind.
  assert.deepEqual(readdirSync(path.dirname(FILE)).filter((f) => f.endsWith('.tmp')), []);
});
