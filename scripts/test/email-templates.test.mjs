// Unit tests for e-mail templates on a lead (#3908, src/lib/messageTemplates.ts).
//
// What goes wrong silently here is the mailto: itself — an unencoded "&" in a
// subject cuts the body off, a bare "\n" is not a line break to every mail
// program, an unfilled "{name}" reaches the customer — and the channel default:
// a request that does not ask for e-mail must keep getting the composer's
// canned replies, or every in-app picker fills with mail templates.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const {
  templateChannel,
  normalizeTemplateSubjects,
  fillEmailPlaceholders,
  emailTemplateMailto,
  serializeMessageTemplate,
  MAX_TEMPLATE_SUBJECT,
} = await import('../../src/lib/messageTemplates.ts');

test('the channel defaults to the composer\'s canned replies', () => {
  assert.equal(templateChannel('email'), 'email');
  assert.equal(templateChannel('message'), 'message');
  for (const v of [null, undefined, '', 'EMAIL', 'sms']) assert.equal(templateChannel(v), 'message');
  // A row written before #3908 has no channel column value of its own: it is a canned reply.
  assert.equal(serializeMessageTemplate({ id: 'a', title: 't', translations: null, useCount: 0, ownerId: null }).channel, 'message');
});

test('subjects keep known locales, one line, bounded', () => {
  assert.deepEqual(normalizeTemplateSubjects({ en: '  Hello\n there ', xx: 'no', de: '' }), { en: 'Hello there' });
  assert.equal(normalizeTemplateSubjects({ en: 'x'.repeat(500) }).en.length, MAX_TEMPLATE_SUBJECT);
  assert.deepEqual(normalizeTemplateSubjects(null), {});
});

test('placeholders fill from the lead; a missing value is empty, other braces stay', () => {
  assert.equal(fillEmailPlaceholders('Hallo {name}, {company} · {sender}', { name: 'Clara', company: 'Acme', sender: 'Rep' }), 'Hallo Clara, Acme · Rep');
  assert.equal(fillEmailPlaceholders('Hallo {name}!', {}), 'Hallo !');
  assert.equal(fillEmailPlaceholders('Code {x} {Name}', { name: 'A' }), 'Code {x} {Name}');
});

test('the mailto carries the writer-language subject and body, encoded, CRLF line breaks', () => {
  const tpl = {
    title: 'Hello {name}',
    translations: { en: 'Hello {name}\nBest, {sender}', de: 'Hallo {name}\nGrüße, {sender}' },
    subjects: { en: 'Offer for {company}', de: 'Angebot für {company} & mehr' },
  };
  const vars = { name: 'Clara', company: 'Acme', sender: 'Rep' };
  const de = emailTemplateMailto('clara@acme.example', tpl, 'de', vars);
  assert.equal(de, `mailto:clara@acme.example?subject=${encodeURIComponent('Angebot für Acme & mehr')}&body=${encodeURIComponent('Hallo Clara\r\nGrüße, Rep')}`);
  const url = new URL(de);
  assert.equal(url.searchParams.get('subject'), 'Angebot für Acme & mehr');
  assert.equal(url.searchParams.get('body'), 'Hallo Clara\r\nGrüße, Rep');
  // A language with no entry falls back to English.
  assert.equal(new URL(emailTemplateMailto('clara@acme.example', tpl, 'tr', vars)).searchParams.get('subject'), 'Offer for Acme');
});
