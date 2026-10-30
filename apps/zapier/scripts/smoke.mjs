// Smoke test against a DEPLOYED environment (#2004): the auth test, one hook
// subscribe → unsubscribe cycle and one action, through the app's own code.
//
//   ICRM_API_KEY=icrm_… npm run smoke                       # shared preview
//   ICRM_BASE_URL=https://pr123.interncrm.com ICRM_API_KEY=… npm run smoke
//
// The key needs `hooks:write` and `candidates:read` (plus `candidates:write`
// for SMOKE_WRITE=1, which also creates one synthetic candidate). It refuses
// production outright: a smoke run is never how the live site gets a row.
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const require = createRequire(import.meta.url);
const zapier = require('zapier-platform-core');
const { baseUrl } = require('../lib/api.js');
const App = require('../index.js');

const apiKey = process.env.ICRM_API_KEY;
if (!apiKey) {
  console.error('ICRM_API_KEY is required (a key from the target environment, never committed).');
  process.exit(2);
}
const target = new URL(baseUrl());
if (target.hostname === 'interncrm.com' || target.hostname === 'www.interncrm.com') {
  console.error(`Refusing to run against production (${target.origin}). Point ICRM_BASE_URL at preview or a PR environment.`);
  process.exit(2);
}

const appTester = zapier.createAppTester(App);
const authData = { apiKey };
const step = async (name, fn) => {
  process.stdout.write(`• ${name} … `);
  const out = await fn();
  console.log('ok');
  return out;
};

console.log(`Zapier app smoke against ${target.origin}`);
const me = await step('auth test (GET /api/v1/me)', () => appTester(App.authentication.test, { authData }));
console.log(`  connection label: ${me.orgName}`);

const trigger = App.triggers.pipeline_stage_changed.operation;
const subscribeData = await step('subscribe pipeline_stage_changed', () =>
  appTester(trigger.performSubscribe, { authData, targetUrl: `https://example.com/zapier-smoke/${randomBytes(4).toString('hex')}` }),
);
await step('unsubscribe it', () => appTester(trigger.performUnsubscribe, { authData, subscribeData }));

const found = await step('find_candidate (an address nobody has)', () =>
  appTester(App.searches.find_candidate.operation.perform, { authData, inputData: { email: `nobody-${randomBytes(4).toString('hex')}@example.test` } }),
);
if (found.length !== 0) throw new Error('expected no candidate for a fresh address');

if (process.env.SMOKE_WRITE === '1') {
  // Unique per run in both fields: the duplicate rule also matches on name.
  const run = randomBytes(4).toString('hex');
  const email = `zapier-smoke-${run}@example.test`;
  const bundle = { authData, meta: { zap: { id: 'smoke' } }, inputData: { fullName: `Zapier Smoke ${run}`, email } };
  const created = await step('create_candidate', () => appTester(App.creates.create_candidate.operation.perform, bundle));
  const again = await step('create_candidate replayed (same Idempotency-Key)', () => appTester(App.creates.create_candidate.operation.perform, bundle));
  if (again.id !== created.id) throw new Error('a replayed action created a second candidate');
}
console.log('smoke passed');
