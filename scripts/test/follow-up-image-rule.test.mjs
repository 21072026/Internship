// Unit tests for follow-up images (#3931, src/lib/followUpImageRule.ts).
// What must hold: the type comes from the bytes; a write can attach only the
// actor's own drafts on this record; the set is bounded; what is dropped from
// the form leaves the panel (cleared), never silently stays.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sniffImageType, checkUpload, planImageSet, currentImages, FOLLOW_UP_IMAGE_BYTES, FOLLOW_UP_IMAGE_MAX } from '../../src/lib/followUpImageRule.ts';

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);
const gif = new TextEncoder().encode('GIF89a....');
const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

test('the type is read from the bytes', () => {
  assert.equal(sniffImageType(png), 'image/png');
  assert.equal(sniffImageType(jpeg), 'image/jpeg');
  assert.equal(sniffImageType(gif), 'image/gif');
  assert.equal(sniffImageType(webp), 'image/webp');
  for (const bad of [new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), new TextEncoder().encode('%PDF-1.7'), new Uint8Array(0)]) {
    assert.equal(sniffImageType(bad), null);
  }
});

test('an upload is an image, not empty, not too large', () => {
  assert.deepEqual(checkUpload(png), { ok: true, type: 'image/png' });
  assert.deepEqual(checkUpload(new Uint8Array(0)), { ok: false, error: 'empty' });
  assert.deepEqual(checkUpload(new TextEncoder().encode('%PDF-1.7')), { ok: false, error: 'not_an_image' });
  const big = new Uint8Array(FOLLOW_UP_IMAGE_BYTES + 1); big.set(png);
  assert.deepEqual(checkUpload(big), { ok: false, error: 'too_large' });
});

const t0 = new Date('2026-11-26T09:00:00Z');
const rows = [
  { id: 'cur1', attachedAt: t0, clearedAt: null, uploaderId: 'rep' },
  { id: 'cur2', attachedAt: t0, clearedAt: null, uploaderId: 'other' },
  { id: 'old', attachedAt: t0, clearedAt: t0, uploaderId: 'rep' },
  { id: 'mine', attachedAt: null, clearedAt: null, uploaderId: 'rep' },
  { id: 'theirs', attachedAt: null, clearedAt: null, uploaderId: 'other' },
];

test('a write keeps what it names, attaches its own drafts and clears the rest', () => {
  assert.deepEqual(planImageSet(rows, ['cur1', 'mine'], 'rep'), { ok: true, attach: ['mine'], clear: ['cur2'] });
  assert.deepEqual(planImageSet(rows, [], 'rep'), { ok: true, attach: [], clear: ['cur1', 'cur2'] });
  assert.deepEqual(planImageSet(rows, ['cur1', 'cur1'], 'rep'), { ok: true, attach: [], clear: ['cur2'] });
});

test('someone else\'s draft, a cleared image or an unknown id is refused, and so is a fourth image', () => {
  for (const id of ['theirs', 'old', 'nope']) assert.deepEqual(planImageSet(rows, [id], 'rep'), { ok: false, error: 'unknown_image' }, id);
  const many = Array.from({ length: FOLLOW_UP_IMAGE_MAX + 1 }, (_, i) => `x${i}`);
  assert.deepEqual(planImageSet(rows, many, 'rep'), { ok: false, error: 'too_many_images' });
  assert.deepEqual(currentImages(rows).map((r) => r.id), ['cur1', 'cur2']);
});

const { imagesByEvent } = await import('../../src/lib/followUpImageRule.ts');

test('an image belongs to the step-setting line it was attached with', () => {
  const at = (s) => new Date(`2026-11-26T10:00:${s}Z`);
  const events = [
    { id: 'e1', kind: 'ASSIGNED', createdAt: at('00') },
    { id: 'e2', kind: 'COMPLETED', createdAt: at('10') },
    { id: 'e3', kind: 'HANDED_OFF', createdAt: at('20') },
  ];
  const images = [
    { id: 'a', attachedAt: at('00') },
    { id: 'b', attachedAt: at('19') }, // a hair before its event's row: same transaction
    { id: 'c', attachedAt: at('30') },
    { id: 'draft', attachedAt: null },
  ];
  const map = imagesByEvent(events, images);
  assert.deepEqual(map.get('e1'), ['a']);
  assert.deepEqual(map.get('e3'), ['b', 'c']);
  assert.equal(map.get('e2'), undefined);
  assert.deepEqual(imagesByEvent([], images).size, 0);
});
