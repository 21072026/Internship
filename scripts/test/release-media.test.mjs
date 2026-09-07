// Tests for release-note media validation (#2233).
//
// WHY THIS EXISTS
//   The rules this file asserts are the only thing standing between the repo
//   and a 4 MB full-page screenshot, a GIF, a twelve-second clip that WCAG
//   2.2.2 would require a pause button for, or a `media` block pointing at a
//   file nobody committed. None of that is catchable by review — it is
//   catchable by a validator that reads the actual bytes, which is what
//   scripts/release-media.cjs does (PNG IHDR for the size, the EBML header for
//   the duration; ffmpeg is not available in CI and is not needed).
//
//   Every fixture below is BUILT here, byte by byte, so the suite carries no
//   binary blobs and each rule is demonstrated against a file that really has
//   the property under test.
//
// USAGE
//   npm run test:release
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  pngSize,
  webmDuration,
  webmVideoSize,
  validateMediaShape,
  resolveMediaAssets,
  changelogMedia,
  releaseNotesMedia,
} = require('../release-media.cjs');
const { resolveRelease } = require('../release-derive.cjs');

// ------------------------------------------------------------------ fixtures

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A real, decodable RGB PNG. `noisy` fills it with random pixels, which do not
 *  compress — that is how the oversized-poster fixture gets over the cap
 *  without being a fake file. */
function makePng(width, height, { noisy = false } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter: none
    if (noisy) for (let i = 1; i <= width * 3; i += 1) raw[row + i] = Math.floor(Math.random() * 256);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** EBML element size, always in the 4-byte form (up to 256 MB — plenty). */
function ebmlSize(length) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(length, 0);
  buffer[0] |= 0x10;
  return buffer;
}

const ID = {
  segment: Buffer.from([0x18, 0x53, 0x80, 0x67]),
  info: Buffer.from([0x15, 0x49, 0xa9, 0x66]),
  timecodeScale: Buffer.from([0x2a, 0xd7, 0xb1]),
  duration: Buffer.from([0x44, 0x89]),
  cluster: Buffer.from([0x1f, 0x43, 0xb6, 0x75]),
  clusterTimecode: Buffer.from([0xe7]),
  tracks: Buffer.from([0x16, 0x54, 0xae, 0x6b]),
  trackEntry: Buffer.from([0xae]),
  video: Buffer.from([0xe0]),
  pixelWidth: Buffer.from([0xb0]),
  pixelHeight: Buffer.from([0xba]),
  displayWidth: Buffer.from([0x54, 0xb0]),
  displayHeight: Buffer.from([0x54, 0xba]),
  void: Buffer.from([0xec]),
};

const el = (id, payload) => Buffer.concat([id, ebmlSize(payload.length), payload]);
const uint = (value) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
};
const float64 = (value) => {
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleBE(value, 0);
  return buffer;
};

/**
 * A WebM whose header says what we need it to say.
 *  - `seconds` present  -> Segment>Info>Duration, the exact case;
 *  - `clusters` present -> cluster timecodes only, which is what a live-muxed
 *    Playwright recording can look like;
 *  - `padBytes`         -> a Void element, to build an over-the-cap file.
 */
function makeWebm({ seconds = null, clusters = [], padBytes = 0, size = null, display = null } = {}) {
  const info = [el(ID.timecodeScale, uint(1_000_000))];
  if (seconds !== null) info.push(el(ID.duration, float64(seconds * 1000))); // ticks of 1 ms
  const body = [el(ID.info, Buffer.concat(info))];
  if (size) {
    // Tracks > TrackEntry > Video > PixelWidth/PixelHeight, which is where the
    // clip's own picture size lives — a different shape from the poster's.
    const video = [el(ID.pixelWidth, uint(size.width)), el(ID.pixelHeight, uint(size.height))];
    if (display) video.push(el(ID.displayWidth, uint(display.width)), el(ID.displayHeight, uint(display.height)));
    body.push(el(ID.tracks, el(ID.trackEntry, el(ID.video, Buffer.concat(video)))));
  }
  for (const ms of clusters) body.push(el(ID.cluster, el(ID.clusterTimecode, uint(ms))));
  if (padBytes) body.push(el(ID.void, Buffer.alloc(padBytes)));
  return el(ID.segment, Buffer.concat(body));
}

/** A throwaway repo root with the directories the resolver expects. */
function makeRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'release-media-'));
  mkdirSync(path.join(root, 'releases', 'unreleased'), { recursive: true });
  mkdirSync(path.join(root, 'public', 'release-media'), { recursive: true });
  return root;
}

const alt = { en: 'The card', tr: 'Kart', de: 'Die Karte' };
const media = (extra = {}) => ({ poster: 'release-media/demo.png', alt, ...extra });

// -------------------------------------------------------------------- header

test('pngSize reads the intrinsic size out of IHDR', () => {
  assert.deepEqual(pngSize(makePng(480, 270)), { width: 480, height: 270 });
  assert.equal(pngSize(Buffer.from('not a png at all, really not')), null);
});

test('webmDuration prefers Segment>Info>Duration', () => {
  const read = webmDuration(makeWebm({ seconds: 3.5, clusters: [0, 1000] }));
  assert.equal(read.source, 'duration');
  assert.ok(Math.abs(read.seconds - 3.5) < 0.001);
});

test('webmDuration falls back to the last cluster when the header carries no Duration', () => {
  // Playwright muxes while recording, so the exact duration is not always
  // written; the last cluster's timecode is a slight under-estimate, never an
  // over-estimate, which is the safe direction for a cap.
  const read = webmDuration(makeWebm({ clusters: [0, 1500, 4200] }));
  assert.equal(read.source, 'clusters');
  assert.ok(Math.abs(read.seconds - 4.2) < 0.001);
});

test('webmDuration reports nothing rather than guessing on a file it cannot read', () => {
  assert.equal(webmDuration(Buffer.from('definitely not webm')), null);
});

// --------------------------------------------------------------------- shape

test('a clip without a still is rejected', () => {
  assert.throws(
    () => validateMediaShape('f.json', { video: 'release-media/demo.webm', alt }),
    /"media\.poster" is required/
  );
});

test('the poster must be a PNG under release-media/, and cannot escape it', () => {
  assert.throws(() => validateMediaShape('f.json', { poster: 'release-media/demo.gif', alt }), /media\.poster/);
  assert.throws(() => validateMediaShape('f.json', { poster: 'demo.png', alt }), /media\.poster/);
  assert.throws(() => validateMediaShape('f.json', { poster: 'release-media/../../etc/x.png', alt }), /media\.poster/);
});

test('a clip must be WebM — never a GIF', () => {
  assert.throws(() => validateMediaShape('f.json', media({ video: 'release-media/demo.gif' })), /media\.video/);
});

test('alt text is all three locales or none', () => {
  assert.throws(() => validateMediaShape('f.json', { poster: 'release-media/demo.png' }), /media\.alt/);
  assert.throws(
    () => validateMediaShape('f.json', { poster: 'release-media/demo.png', alt: { en: 'x', tr: 'y' } }),
    /media\.alt\.de/
  );
  assert.throws(
    () => validateMediaShape('f.json', { poster: 'release-media/demo.png', alt: { ...alt, fr: 'non' } }),
    /unknown media\.alt locale/
  );
  assert.doesNotThrow(() => validateMediaShape('f.json', media()));
});

test('an unknown media field is rejected rather than silently ignored', () => {
  assert.throws(() => validateMediaShape('f.json', media({ caption: 'nope' })), /unknown media field/);
});

// -------------------------------------------------------------------- assets

test('a valid poster resolves, carrying its pixel size', () => {
  const root = makeRepo();
  try {
    writeFileSync(path.join(root, 'public', 'release-media', 'demo.png'), makePng(600, 320));
    const resolved = resolveMediaAssets(root, 'f.json', media());
    assert.equal(resolved.width, 600);
    assert.equal(resolved.height, 320);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a media block pointing at a file nobody committed fails', () => {
  const root = makeRepo();
  try {
    assert.throws(() => resolveMediaAssets(root, 'f.json', media()), /media\.poster not found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a full-page-sized poster is over the cap', () => {
  const root = makeRepo();
  try {
    // Random pixels do not compress: ~380 KB, well past the 150 KB cap.
    writeFileSync(path.join(root, 'public', 'release-media', 'demo.png'), makePng(360, 360, { noisy: true }));
    assert.throws(() => resolveMediaAssets(root, 'f.json', media()), /over the 150 KB cap/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a clip over five seconds is rejected (WCAG 2.2.2)', () => {
  const root = makeRepo();
  try {
    writeFileSync(path.join(root, 'public', 'release-media', 'demo.png'), makePng(480, 270));
    writeFileSync(path.join(root, 'public', 'release-media', 'demo.webm'), makeWebm({ seconds: 7.5 }));
    assert.throws(
      () => resolveMediaAssets(root, 'f.json', media({ video: 'release-media/demo.webm' })),
      /runs 7\.50s, over the 5s cap/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a clip of five seconds or less passes', () => {
  const root = makeRepo();
  try {
    writeFileSync(path.join(root, 'public', 'release-media', 'demo.png'), makePng(480, 270));
    writeFileSync(path.join(root, 'public', 'release-media', 'demo.webm'), makeWebm({ clusters: [0, 2400, 4800] }));
    assert.doesNotThrow(() => resolveMediaAssets(root, 'f.json', media({ video: 'release-media/demo.webm' })));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an oversized clip is rejected before its duration is even read', () => {
  const root = makeRepo();
  try {
    writeFileSync(path.join(root, 'public', 'release-media', 'demo.png'), makePng(480, 270));
    writeFileSync(
      path.join(root, 'public', 'release-media', 'demo.webm'),
      makeWebm({ seconds: 2, padBytes: 2 * 1024 * 1024 })
    );
    assert.throws(
      () => resolveMediaAssets(root, 'f.json', media({ video: 'release-media/demo.webm' })),
      /over the 1536 KB cap/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a WebM whose duration cannot be read is refused, not waved through', () => {
  const root = makeRepo();
  try {
    writeFileSync(path.join(root, 'public', 'release-media', 'demo.png'), makePng(480, 270));
    writeFileSync(path.join(root, 'public', 'release-media', 'demo.webm'), Buffer.from('not a webm'));
    assert.throws(
      () => resolveMediaAssets(root, 'f.json', media({ video: 'release-media/demo.webm' })),
      /could not read a duration/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- the whole way

test('a fragment carries its media into the release timeline', () => {
  const root = makeRepo();
  try {
    writeFileSync(path.join(root, 'public', 'release-media', 'demo.png'), makePng(480, 270));
    writeFileSync(
      path.join(root, 'releases', 'unreleased', 'demo.json'),
      JSON.stringify({
        bump: 'minor',
        changelog: '- **Demo** (#2233).',
        notes: { en: ['en'], tr: ['tr'], de: ['de'] },
        media: media(),
      })
    );
    const { timeline } = resolveRelease(root, '0.1.0-beta');
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0].media.poster, 'release-media/demo.png');
    assert.equal(timeline[0].media.width, 480);
    assert.equal(timeline[0].media.height, 270);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a fragment WITHOUT media stays completely valid — media is never required', () => {
  const root = makeRepo();
  try {
    writeFileSync(
      path.join(root, 'releases', 'unreleased', 'plain.json'),
      JSON.stringify({ bump: 'patch', changelog: '- **Plain** (#2233).' })
    );
    const { timeline } = resolveRelease(root, '0.1.0-beta');
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0].media, undefined);
    assert.equal(timeline[0].version, '0.1.1-beta');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------- the clip's own picture size

test('webmVideoSize reads PixelWidth/PixelHeight out of Tracks>TrackEntry>Video', () => {
  assert.deepEqual(webmVideoSize(makeWebm({ seconds: 2, size: { width: 640, height: 400 } })), {
    width: 640,
    height: 400,
  });
});

test('webmVideoSize prefers DisplayWidth/DisplayHeight — the size the picture should be SHOWN at', () => {
  const webm = makeWebm({ seconds: 2, size: { width: 640, height: 480 }, display: { width: 854, height: 480 } });
  assert.deepEqual(webmVideoSize(webm), { width: 854, height: 480 });
});

test('webmVideoSize reports nothing rather than guessing when the file declares no track', () => {
  assert.equal(webmVideoSize(makeWebm({ seconds: 2 })), null);
  assert.equal(webmVideoSize(Buffer.from('not a webm at all')), null);
});

test('a clip resolves with ITS OWN size, separate from the poster\'s', () => {
  const root = makeRepo();
  try {
    // The two captures have unrelated shapes by construction: the poster is a
    // cropped element, the clip a scaled viewport. Handing the poster's aspect
    // ratio to the <video> laid the clip out letterboxed inside its own frame.
    writeFileSync(path.join(root, 'public', 'release-media', 'demo.png'), makePng(1052, 300));
    writeFileSync(
      path.join(root, 'public', 'release-media', 'demo.webm'),
      makeWebm({ seconds: 2, size: { width: 640, height: 400 } })
    );
    const resolved = resolveMediaAssets(root, 'demo.json', media({ video: 'release-media/demo.webm' }));
    assert.equal(resolved.width, 1052);
    assert.equal(resolved.height, 300);
    assert.equal(resolved.videoWidth, 640);
    assert.equal(resolved.videoHeight, 400);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a clip whose header declares no size still resolves — the poster is never guessed at', () => {
  const root = makeRepo();
  try {
    writeFileSync(path.join(root, 'public', 'release-media', 'demo.png'), makePng(480, 270));
    writeFileSync(path.join(root, 'public', 'release-media', 'demo.webm'), makeWebm({ seconds: 2 }));
    const resolved = resolveMediaAssets(root, 'demo.json', media({ video: 'release-media/demo.webm' }));
    assert.equal(resolved.width, 480);
    assert.equal(resolved.videoWidth, undefined);
    assert.equal(resolved.videoHeight, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------- what compaction writes
//
// These two writers produce the PERMANENT record: the markdown that lands in
// CHANGELOG.md and the TypeScript that lands in src/lib/releaseNotes.ts. The
// compaction cron runs them long after the PR is merged, so a mistake here is
// found by whoever happens to be reading a broken release page — which is why
// they live in release-media.cjs (importable) rather than inside the top-level
// compaction script (not importable).

test('changelogMedia writes the POSTER as markdown, never the clip', () => {
  const out = changelogMedia({ ...media({ video: 'release-media/demo.webm' }), width: 480, height: 270 });
  assert.equal(out, '![The card](public/release-media/demo.png)\n\n');
  assert.ok(!out.includes('.webm'), 'markdown cannot play a video');
});

test('changelogMedia escapes brackets in the alt so the image syntax cannot break', () => {
  const out = changelogMedia({ poster: 'release-media/demo.png', alt: { en: 'The [new] card', tr: 'x', de: 'y' } });
  assert.equal(out, '![The new card](public/release-media/demo.png)\n\n');
});

test('changelogMedia contributes nothing for a note without media', () => {
  assert.equal(changelogMedia(undefined), '');
  assert.equal(changelogMedia(null), '');
});

test('releaseNotesMedia emits a valid, indented entry carrying both sizes', () => {
  const out = releaseNotesMedia({
    poster: 'release-media/demo.png',
    video: 'release-media/demo.webm',
    alt,
    width: 1052,
    height: 300,
    videoWidth: 640,
    videoHeight: 400,
  });
  assert.equal(
    out,
    '    media: {\n' +
      '      poster: "release-media/demo.png",\n' +
      '      video: "release-media/demo.webm",\n' +
      '      alt: {\n' +
      '        en: "The card",\n' +
      '        tr: "Kart",\n' +
      '        de: "Die Karte",\n' +
      '      },\n' +
      '      width: 1052,\n' +
      '      height: 300,\n' +
      '      videoWidth: 640,\n' +
      '      videoHeight: 400,\n' +
      '    },\n'
  );
});

test('releaseNotesMedia omits video and its size for a poster-only note', () => {
  const out = releaseNotesMedia({ poster: 'release-media/demo.png', alt, width: 640, height: 130 });
  assert.ok(!out.includes('video'), 'no video key, and no videoWidth/videoHeight either');
  assert.match(out, /width: 640,/);
  assert.match(out, /height: 130,/);
});

test('releaseNotesMedia produces TypeScript that actually parses, with the alt intact', () => {
  // The generated text is spliced into a source file nobody re-reads by hand;
  // a stray quote or a missing comma would only surface as a build failure on
  // the compaction PR. Evaluate it as an object literal to prove it is valid.
  const tricky = { en: 'A "quoted" card', tr: 'Bir \'tırnaklı\' kart', de: 'Eine Karte\nmit Zeilenumbruch' };
  const out = releaseNotesMedia({ poster: 'release-media/demo.png', alt: tricky, width: 10, height: 20 });
  const parsed = new Function(`return {\n${out}};`)();
  assert.deepEqual(parsed.media.alt, tricky);
  assert.equal(parsed.media.poster, 'release-media/demo.png');
});

test('releaseNotesMedia contributes nothing for a note without media', () => {
  assert.equal(releaseNotesMedia(undefined), '');
});
