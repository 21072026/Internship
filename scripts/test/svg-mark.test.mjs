import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SVG_MARK_MAX_BYTES, SVG_MARK_MAX_USES, validateSvgMark } from '../../src/lib/svgMark.ts';

// The SVG an admin uploads as an organization's mark (#2922) is rasterized by
// librsvg on the production host. It is never served, so this is not about
// XSS in a browser; it is about what the RASTERIZER can be made to do — read a
// local file, fetch a URL, expand entities, render forever. Every hostile file
// below must be refused, and the honest marks at the top must still pass, or
// the feature is useless.

const wrap = (inner, attrs = 'viewBox="0 0 64 64"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs}>${inner}</svg>`;

const ok = (svg) => {
  const v = validateSvgMark(svg);
  assert.equal(v.ok, true, `expected accepted, got ${v.ok ? 'ok' : v.reason}:\n${svg.slice(0, 200)}`);
};
const refused = (svg, reason) => {
  const v = validateSvgMark(svg);
  assert.equal(v.ok, false, `expected refused (${reason}):\n${svg.slice(0, 300)}`);
  if (reason) assert.equal(v.reason, reason, svg.slice(0, 300));
};

// ── Honest marks ─────────────────────────────────────────────────────────────

test('plain shapes, gradients, in-document references and an XML declaration pass', () => {
  ok(wrap('<circle cx="32" cy="32" r="24" fill="#0e7490"/>'));
  ok(`<?xml version="1.0" encoding="UTF-8"?>\n<!-- exported by a design tool -->\n${wrap('<rect width="64" height="64" rx="14"/>')}`);
  ok(
    wrap(
      '<defs><linearGradient id="g1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fde047"/><stop offset="1" stop-color="#f97316"/></linearGradient>' +
        '<path id="p" d="M8 8h48v48H8z"/></defs><use href="#p" fill="url(#g1)"/><use xlink:href="#p" style="fill:url( \'#g1\' )"/>',
    ),
  );
  ok(wrap('<style>.a{fill:#123456}</style><path class="a" d="M0 0h10v10z"/>'));
  ok(wrap('<text x="4" y="40" font-family="sans-serif">A &amp; B &lt;3</text>'));
  ok(wrap('<path d="M0 0h1z"/>', 'viewBox="-10.3 -27.13 193.26 193.26"'));
  ok(wrap('<path d="M0 0h1z"/>', "viewBox='0,0,100,100' width=\"64\" height=\"64\""));
});

// ── Entities, DOCTYPE, processing instructions ───────────────────────────────

test('DOCTYPE and ENTITY declarations are refused (billion laughs, XXE)', () => {
  refused(`<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]>${wrap('<text>&b;</text>')}`, 'doctype');
  refused(`<!DOCTYPE svg SYSTEM "file:///etc/passwd">${wrap('')}`, 'doctype');
  refused(`<!doctype svg>${wrap('')}`, 'doctype');
  refused(wrap('<!ENTITY x SYSTEM "file:///etc/passwd">'), 'declaration');
  refused(wrap('<![CDATA[ <script>alert(1)</script> ]]>'), 'declaration');
});

test('processing instructions other than the leading XML declaration are refused', () => {
  refused(`<?xml-stylesheet href="https://example.test/x.css"?>${wrap('')}`, 'processing_instruction');
  refused(wrap('<?php echo 1; ?>'), 'processing_instruction');
});

// ── Elements that load, embed or animate something ───────────────────────────

test('script, foreignObject, image, feImage, XInclude, fonts and animation elements are refused', () => {
  for (const inner of [
    '<script>alert(1)</script>',
    '<SCRIPT>alert(1)</SCRIPT>',
    '<svg:script>alert(1)</svg:script>',
    '<foreignObject><iframe src="https://example.test"/></foreignObject>',
    '<image href="#x"/>',
    '<image xlink:href="#x" width="10" height="10"/>',
    '<filter id="f"><feImage href="#x"/></filter>',
    '<xi:include xmlns:xi="http://www.w3.org/2001/XInclude" href="#x" parse="text"/>',
    '<font><font-face font-family="x"/></font>',
    '<font-face><font-face-src><font-face-uri href="#x"/></font-face-src></font-face>',
    '<set attributeName="fill" to="red"/>',
    '<animate attributeName="href" values="#a"/>',
    '<animateTransform attributeName="transform" type="rotate" from="0" to="360"/>',
    '<iframe/>',
    '<embed/>',
    '<object/>',
    '<audio/>',
    '<video/>',
    '<handler/>',
    '<cursor href="#c"/>',
    '<link rel="stylesheet"/>',
  ]) {
    refused(wrap(inner), 'forbidden_element');
  }
});

test('a lookalike element name is not mistaken for a forbidden one', () => {
  ok(wrap('<g class="images"><path d="M0 0h1z"/></g>'));
  ok(wrap('<symbol id="s"><path d="M0 0h1z"/></symbol><use href="#s"/>'));
});

// ── Attributes ───────────────────────────────────────────────────────────────

test('event handlers and src attributes are refused', () => {
  refused(wrap('', 'viewBox="0 0 64 64" onload="alert(1)"'), 'event_handler');
  refused(wrap('<rect width="1" height="1" onclick="x()"/>'), 'event_handler');
  refused(wrap('<rect width="1" height="1" ONMOUSEOVER = "x()"/>'), 'event_handler');
  refused(wrap('<rect width="1" height="1" src="x"/>'), 'src_attribute');
});

test('every href must point inside the document', () => {
  for (const href of ['https://example.test/x.svg', 'http://169.254.169.254/latest/meta-data/', 'file:///etc/passwd', '/etc/passwd', 'x.svg#a', ' https://example.test', '']) {
    refused(wrap(`<use href="${href}"/>`), 'external_reference');
    refused(wrap(`<use xlink:href="${href}"/>`), 'external_reference');
  }
  refused(wrap('<a:use xmlns:a="http://www.w3.org/1999/xlink" a:href="https://example.test"/>'), 'external_reference');
  // An unquoted value is not well-formed XML, and is not let through unread.
  refused(wrap('<use href=https://example.test/x />'), 'external_reference');
  refused(wrap('<pattern id="p" href="https://example.test/p.svg"/>'), 'external_reference');
  refused(wrap('<textPath href="//example.test/x"/>'), 'external_reference');
});

test('every CSS url() must point inside the document, and @import is refused', () => {
  refused(wrap('<rect width="1" height="1" fill="url(https://example.test/g.svg#g)"/>'), 'external_url');
  refused(wrap('<rect width="1" height="1" style="fill:url(\'/etc/passwd\')"/>'), 'external_url');
  refused(wrap('<style>rect{fill:url(http://169.254.169.254/)}</style>'), 'external_url');
  refused(wrap('<rect width="1" height="1" filter="url( file:///x )"/>'), 'external_url');
  refused(wrap('<style>@import "https://example.test/x.css";</style>'), 'css_import');
  refused(wrap('<style>@IMPORT url(#x);</style>'), 'css_import');
});

test('script URLs are refused wherever they hide, whitespace and case notwithstanding', () => {
  refused(wrap('<a href="#x"><rect width="1" height="1" fill="javascript:alert(1)"/></a>'), 'script_url');
  refused(wrap('<rect width="1" height="1" class="java\tscript:alert(1)"/>'), 'script_url');
  refused(wrap('<rect width="1" height="1" class="JaVaScRiPt:alert(1)"/>'), 'script_url');
  refused(wrap('<rect width="1" height="1" class="vbscript:x"/>'), 'script_url');
  refused(wrap('<rect width="1" height="1" class="data:image/svg+xml;base64,PHN2Zz4="/>'), 'script_url');
});

test('escapes that would spell a refused word are refused themselves', () => {
  refused(wrap('<use href="&#104;ttps://example.test/x"/>'), 'escape');
  refused(wrap('<rect fill="&#x75;rl(https://example.test)"/>'), 'escape');
  refused(wrap('<rect class="&custom;"/>'), 'escape');
  refused(wrap('<style>rect{fill:u\\72l(https://example.test)}</style>'), 'escape');
  refused(wrap('<style>@\\69mport "x";</style>'), 'escape');
});

// ── Shape, size, encoding ────────────────────────────────────────────────────

test('the root must be <svg> with a square viewBox', () => {
  refused('<html><svg viewBox="0 0 64 64"/></html>', 'not_svg');
  refused(`<g>${wrap('')}</g>`, 'not_svg');
  refused('not an svg at all', 'not_svg');
  refused('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"></svg>', 'viewbox_missing');
  refused(wrap('', 'viewBox="0 0 64"'), 'viewbox_missing');
  refused(wrap('', 'viewBox="0 0 64 32"'), 'viewbox_not_square');
  refused(wrap('', 'viewBox="0 0 0 0"'), 'viewbox_not_square');
  refused(wrap('', 'viewBox="0 0 -64 -64"'), 'viewbox_not_square');
});

test('oversized, non-UTF-8 and reference-bomb files are refused', () => {
  refused(wrap(`<!--${'x'.repeat(SVG_MARK_MAX_BYTES)}-->`), 'too_large');
  refused(new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0x20, 0xff, 0xfe, 0x3e]), 'not_utf8');
  const uses = Array.from({ length: SVG_MARK_MAX_USES + 1 }, () => '<use href="#p"/>').join('');
  refused(wrap(`<defs><path id="p" d="M0 0h1z"/></defs>${uses}`), 'too_many_uses');
  const fine = Array.from({ length: SVG_MARK_MAX_USES }, () => '<use href="#p"/>').join('');
  ok(wrap(`<defs><path id="p" d="M0 0h1z"/></defs>${fine}`));
});

test('bytes and strings are judged the same, a BOM is tolerated', () => {
  const svg = wrap('<circle cx="32" cy="32" r="24"/>');
  assert.equal(validateSvgMark(new TextEncoder().encode(svg)).ok, true);
  assert.equal(validateSvgMark(`﻿${svg}`).ok, true);
  assert.deepEqual(validateSvgMark(svg), { ok: true, viewBox: [0, 0, 64, 64] });
});
