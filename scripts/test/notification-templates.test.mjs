// Unit tests for the notification template renderer (#1718) — hostile input first.
//
// Run: npm run test:notification-templates  (node --test --experimental-strip-types)
//
// What is pinned: nothing outside the tag/attribute allowlist survives the body
// sanitiser (script, on*, javascript:/data: links, external images, styles,
// entity-encoded schemes, nested-tag tricks); merge tags outside the event's
// allowlist render literally and never read a value; values are escaped and
// can never become markup; a broken template is refused so the caller falls
// back; the row pick is programme → org → none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BRAND_TAGS,
  allowedTags,
  escapeHtml,
  firstNameOf,
  interpolateDefault,
  pickTemplateRow,
  renderStoredTemplate,
  safeHref,
  sanitizeBody,
  sanitizeSubject,
  stripTags,
  tagsIn,
} from '../../src/lib/notifications/templateRender.ts';

const HOSTILE = [
  '<script>alert(1)</script>',
  '<SCRIPT SRC=//evil.example/x.js></SCRIPT>',
  '<img src="https://tracker.example/pixel.gif">',
  '<img src=x onerror=alert(1)>',
  '<p onclick="alert(1)">hi</p>',
  '<a href="javascript:alert(1)">x</a>',
  '<a href="JaVaScRiPt:alert(1)">x</a>',
  '<a href="&#106;avascript:alert(1)">x</a>',
  '<a href="&#x6A;avascript&colon;alert(1)">x</a>',
  '<a href="java\tscript:alert(1)">x</a>',
  '<a href=" javascript:alert(1)">x</a>',
  '<a href="data:text/html,<script>alert(1)</script>">x</a>',
  '<a href="vbscript:msgbox(1)">x</a>',
  '<iframe src="https://evil.example"></iframe>',
  '<svg onload=alert(1)><circle/></svg>',
  '<style>body{background:url(https://tracker.example)}</style>',
  '<p style="background:url(https://tracker.example)">x</p>',
  '<scr<script>ipt>alert(1)</scr</script>ipt>',
  '<<script>script>alert(1)<</script>/script>',
  '&lt;script&gt;alert(1)&lt;/script&gt;',
  '<!--<script>alert(1)</script>-->',
  '<a href="https://ok.example" onmouseover="alert(1)">x</a>',
  '<form action="https://evil.example"><input name=p></form>',
  '<meta http-equiv="refresh" content="0;url=https://evil.example">',
  '<base href="https://evil.example/">',
  '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
];

function assertInert(html) {
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img/i);
  assert.doesNotMatch(html, /<iframe|<svg|<style|<form|<input|<meta|<base|<math/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /javascript:|vbscript:|data:/i);
  assert.doesNotMatch(html, /style=/i);
  // Every tag left is one of ours.
  for (const m of html.matchAll(/<\/?([a-z0-9]+)/gi)) {
    assert.ok(['p', 'br', 'strong', 'b', 'em', 'i', 'u', 'a', 'ul', 'ol', 'li', 'h2', 'h3', 'blockquote'].includes(m[1].toLowerCase()), m[0]);
  }
}

test('hostile bodies come out inert', () => {
  for (const h of HOSTILE) {
    const out = sanitizeBody(`<p>Hello</p>${h}<p>Bye</p>`);
    assertInert(out);
    assert.match(out, /<p>Hello<\/p>/, h);
  }
});

test('the allowlist keeps formatting and safe links', () => {
  assert.equal(sanitizeBody('<p>Hi <strong>you</strong><br/>there</p>'), '<p>Hi <strong>you</strong><br>there</p>');
  assert.equal(
    sanitizeBody('<a href="https://acme.example/x?a=1&amp;b=2" target="_blank" class="c">go</a>'),
    '<a href="https://acme.example/x?a=1&amp;b=2" rel="noopener noreferrer">go</a>',
  );
  assert.equal(sanitizeBody('<a href="mailto:help@acme.example">mail</a>'), '<a href="mailto:help@acme.example" rel="noopener noreferrer">mail</a>');
  assert.equal(sanitizeBody('<a href="/relative">x</a>'), '<a>x</a>');
  // Unbalanced input comes out balanced; a stray closer is dropped.
  assert.equal(sanitizeBody('<p><em>open'), '<p><em>open</em></p>');
  assert.equal(sanitizeBody('text</p>'), 'text');
  // Text is escaped; a bare < is text.
  assert.equal(sanitizeBody('1 < 2 & "q"'), '1 &lt; 2 &amp; &quot;q&quot;');
});

test('safeHref', () => {
  assert.equal(safeHref('https://a.example'), 'https://a.example');
  assert.equal(safeHref('http://a.example'), 'http://a.example');
  assert.equal(safeHref('mailto:x@a.example'), 'mailto:x@a.example');
  for (const bad of ['javascript:x', ' javascript:x', 'java\nscript:x', '&#106;avascript:x', 'data:x', 'ftp://a', '//a.example', '', 'nope']) {
    assert.equal(safeHref(bad), null, bad);
  }
});

test('a subject is plain text on one line', () => {
  assert.equal(sanitizeSubject('  Hello <b>there</b>\r\nBcc: x@evil.example '), 'Hello there Bcc: x@evil.example');
  assert.equal(sanitizeSubject('x'.repeat(400)).length, 255);
});

test('no markup survives into a subject: nested, encoded or half a tag', () => {
  // One pass of a tag pattern leaves the outer tag of a nested one standing.
  assert.equal(sanitizeSubject('<<b>script>alert(1)<</b>/script>Hi'), 'alert(1)Hi');
  // Entities are decoded before the tags go, so an encoded tag is removed too.
  assert.equal(sanitizeSubject('&lt;img src=x onerror=alert(1)&gt;Hi'), 'Hi');
  assert.equal(sanitizeSubject('&#60;script&#62;x&#60;/script&#62; done'), 'x done');
  // A stray angle bracket never reaches the subject.
  assert.equal(sanitizeSubject('5 < 6'), '5 6');
  assert.equal(sanitizeSubject('7 > 3'), '7 3');
  for (const s of HOSTILE) assert.doesNotMatch(sanitizeSubject(s), /[<>]/, s);
});

test('stripTags removes tags until none is left', () => {
  assert.equal(stripTags('<p><<b>i>x</i></p>'), 'x');
  assert.equal(stripTags('<<<b>b>b>y'), 'y');
  assert.doesNotMatch(stripTags('<scr<b>ipt>'), /[<>]/);
});

test('merge tags: the event params plus the brand set, nothing else', () => {
  const allowed = allowedTags(['menteeName']);
  assert.deepEqual([...allowed].sort(), ['menteeName', ...BRAND_TAGS].sort());
  assert.deepEqual(tagsIn('{{ a }} {{b.c}} {x}'), ['a', 'b.c']);
  const out = renderStoredTemplate(
    { subject: 'News for {{recipient.firstName}}', body: '<p>{{menteeName}} · {{brand.name}} · {{user.password}} · {{constructor}}</p>' },
    ['menteeName'],
    { menteeName: '<img src=x onerror=alert(1)>', 'brand.name': 'Acme Sales', 'recipient.firstName': 'Ada', 'user.password': 'LEAK', constructor: 'LEAK' },
  );
  assert.equal(out.ok, true);
  assert.equal(out.subject, 'News for Ada');
  // The value is escaped text; the unknown tags are literal and read nothing.
  assert.equal(out.html, '<p>&lt;img src=x onerror=alert(1)&gt; · Acme Sales · {{user.password}} · {{constructor}}</p>');
  assert.doesNotMatch(out.html, /LEAK/);
});

test('a link may be exactly {{brand.url}}, and a value never becomes a scheme', () => {
  const out = renderStoredTemplate(
    { subject: 'x', body: '<a href="{{brand.url}}">open</a> <a href="{{menteeName}}">bad</a>' },
    ['menteeName'],
    { 'brand.url': 'https://app.acme.example', menteeName: 'javascript:alert(1)' },
  );
  assert.equal(out.ok, true);
  assert.equal(out.html, '<a href="https://app.acme.example" rel="noopener noreferrer">open</a> <a>bad</a>');
});

test('a template that cannot be used is refused, so the caller falls back', () => {
  assert.deepEqual(renderStoredTemplate({ subject: '   ', body: '<p>x</p>' }, [], {}), { ok: false, reason: 'empty_subject' });
  assert.deepEqual(renderStoredTemplate({ subject: '<b></b>', body: '<p>x</p>' }, [], {}), { ok: false, reason: 'empty_subject' });
  assert.deepEqual(renderStoredTemplate({ subject: '{{offerAmount}}', body: '<p>x</p>' }, [], {}), { ok: false, reason: 'unknown_subject_tag' });
  assert.deepEqual(renderStoredTemplate({ subject: 'Hi', body: '<script>x</script>' }, [], {}), { ok: false, reason: 'empty_body' });
  assert.deepEqual(renderStoredTemplate({ subject: 'Hi', body: '<p><b></b></p><br>' }, [], {}), { ok: false, reason: 'empty_body' });
  // A subject that is only an allowed tag with no value is empty too.
  assert.deepEqual(renderStoredTemplate({ subject: '{{name}}', body: '<p>x</p>' }, ['name'], {}), { ok: false, reason: 'empty_subject' });
});

test('row pick: programme → org → none', () => {
  const org = { programId: '', id: 'o' };
  const prog = { programId: 'p1', id: 'p' };
  assert.equal(pickTemplateRow([org, prog], 'p1')?.id, 'p');
  assert.equal(pickTemplateRow([org, prog], null)?.id, 'o');
  assert.equal(pickTemplateRow([org], 'p2')?.id, 'o');
  assert.equal(pickTemplateRow([prog], null), null);
  assert.equal(pickTemplateRow([], 'p1'), null);
});

test('the small helpers', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(interpolateDefault('Hi {name}, {missing}', { name: 'Ada' }), 'Hi Ada, {missing}');
  assert.equal(firstNameOf('  Ada  Lovelace '), 'Ada');
  assert.equal(firstNameOf(null), '');
});
