// The hard rule of #2048: no AI-generated text is ever sent by a cron or by
// any code path without a person pressing Send. Static, because the rule is
// about which code may reach which — a behavioural test can only sample it.
//
//  1. The modules that SEND on their own (the dormant check-ins, the outcome
//     auto-send, the cron entry point, the e-mail service with its scheduled
//     jobs) never import an AI module. `outcomeAutoSend` therefore can only
//     ever send the templated text it always sent.
//  2. The AI draft modules and the routes that serve them never send, post,
//     notify or log a message: they return text to a composer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

const AUTO_SENDERS = [
  'src/lib/outcomeComms.server.ts',
  'src/lib/dormantFirstContact.ts',
  'src/app/api/cron/route.ts',
  'src/services/emailService.ts',
];
const AI_MODULES = /from ['"]@\/lib\/(aiOutreach|aiThread|aiSummary|aiGate|ai\/provider)['"]/;

const DRAFTERS = [
  'src/lib/aiOutreach.ts',
  'src/lib/aiThread.ts',
  'src/app/api/mentorship/[id]/ai-draft/route.ts',
  'src/app/api/ai/bulk-draft/route.ts',
  'src/app/api/conversations/[id]/suggest-reply/route.ts',
  'src/app/api/conversations/[id]/summary/route.ts',
];
const SENDS = /\b(sendEmail|sendNewMessagePush|notifyIfAllowed|notify)\s*\(|\bmessage\.create\b|\binteractionLog\.create\b|\bpublishRealtime\b/;

test('every listed file exists (a rename must not silently empty the rule)', () => {
  for (const f of [...AUTO_SENDERS, ...DRAFTERS]) assert.ok(existsSync(new URL(`../../${f}`, import.meta.url)), f);
});

test('the code paths that send on their own never import an AI module', () => {
  for (const f of AUTO_SENDERS) assert.doesNotMatch(read(f), AI_MODULES, `${f} must not reach an AI module (#2048)`);
});

test('the AI draft modules and their routes never send, notify or log a message', () => {
  for (const f of DRAFTERS) assert.doesNotMatch(read(f), SENDS, `${f} must only return text (#2048)`);
});

test('the outcome auto-send still sends the dictionary template, nothing generated', () => {
  const src = read('src/lib/outcomeComms.server.ts');
  assert.match(src, /getSetting\('outcomeAutoSend'/);
  assert.match(src, /emailTemplates/);
});
