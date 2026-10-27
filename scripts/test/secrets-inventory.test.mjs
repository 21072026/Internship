// docs/secrets-and-rotation.md classifies every variable in .env.example (#1554).
// A new variable that is not named there ships unclassified — a secret with no
// owner, no blast radius and no rotation step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const env = readFileSync('.env.example', 'utf8');
const doc = readFileSync('docs/secrets-and-rotation.md', 'utf8');

/** Every assignment in .env.example, commented-out examples included. */
function envNames(text) {
  const names = new Set();
  for (const line of text.split('\n')) {
    const m = /^#?\s?([A-Z][A-Z0-9_]+)=/.exec(line);
    if (m) names.add(m[1]);
  }
  return [...names];
}

test('.env.example has variables to check', () => {
  assert.ok(envNames(env).length > 50);
});

test('every .env.example variable is named in the secrets inventory', () => {
  const missing = envNames(env).filter((n) => !doc.includes('`' + n + '`'));
  assert.deepEqual(missing, [], `add these to docs/secrets-and-rotation.md: ${missing.join(', ')}`);
});
