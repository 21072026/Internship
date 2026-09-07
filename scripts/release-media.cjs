// Release-note media (#2233): the optional screenshot — or short clip — a
// release fragment may carry.
//
// A release note that says "mentees can request a mentor from the directory
// card" tells a reader who has not seen that screen nothing. One small picture
// answers it, and Playwright already drives the screen, so the picture is
// nearly free (e2e/release-media.spec.ts captures it).
//
// This module is the *rule*: what a `media` block may look like, and what the
// files it points at must be. It is required from scripts/release-derive.cjs,
// which is itself required from next.config.js — so, like its caller, it is
// dependency-free CommonJS that must never throw on a merely missing file tree
// (a Docker build stage without public/ still has to produce a version).
//
// The three hard limits and why they exist:
//   - a POSTER (.png) is always required, a VIDEO (.webm) never is. Three
//     surfaces show this media and none of them can play video: CHANGELOG.md is
//     markdown, an older iOS PWA install may not decode WebM, and
//     prefers-reduced-motion must have something to show instead of motion. One
//     poster serves all three.
//   - a clip is at most 5 seconds. WCAG 2.2.2 (Pause, Stop, Hide) requires
//     automatically-moving content longer than that to be pausable; staying
//     under the threshold keeps a control off every release card.
//   - size caps (150 KB / 1.5 MB) keep the repo bounded — the media is
//     committed under public/, deliberately (see releases/README.md).
//
// The duration check reads the WebM header here rather than shelling out to
// ffprobe: ffmpeg is not installed in CI, and Playwright produces WebM natively.

const { readFileSync, existsSync, statSync } = require('node:fs');
const path = require('node:path');

/** Everything lives under public/release-media/<fragment-slug>.{png,webm}. */
const MEDIA_DIR = 'release-media';
const PUBLIC_DIR = 'public';
const LOCALES = ['en', 'tr', 'de'];

/** A cropped element screenshot is 40-80 KB; this only catches a full-page
 *  capture pasted in by mistake. */
const MAX_POSTER_BYTES = 150 * 1024;
const MAX_VIDEO_BYTES = 1.5 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 5;
/** Muxer rounding: a clip authored at exactly 5s can mux as 5.004s. */
const DURATION_EPSILON = 0.05;

/** `release-media/<kebab-slug>.<ext>`, and nothing that can climb out of it. */
const posterPattern = /^release-media\/[a-z0-9][a-z0-9-]*\.png$/;
const videoPattern = /^release-media\/[a-z0-9][a-z0-9-]*\.webm$/;

// ---------------------------------------------------------------- PNG header

/**
 * Intrinsic pixel size from a PNG's IHDR chunk, which is always the first one
 * and always at the same offset. Returns null for anything that is not a PNG.
 *
 * Why we need it at all: the page sets width/height on the <img>/<video> so the
 * release-notes list does not reflow when the image arrives. The fragment
 * author should not have to type the numbers in, so they are read here and
 * carried into the release entry.
 */
function pngSize(buffer) {
  const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(SIGNATURE)) return null;
  if (buffer.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height };
}

// --------------------------------------------------------------- EBML / WebM

/** WebM is EBML. Only the four elements the duration depends on matter here. */
const EL = {
  SEGMENT: 0x18538067,
  INFO: 0x1549a966,
  CLUSTER: 0x1f43b675,
  TIMECODE_SCALE: 0x2ad7b1, // nanoseconds per tick; defaults to 1e6 (= 1ms)
  DURATION: 0x4489, // float, in ticks
  CLUSTER_TIMECODE: 0xe7, // uint, in ticks
};
const MASTERS = new Set([EL.SEGMENT, EL.INFO, EL.CLUSTER]);

/**
 * One EBML variable-length integer. IDs keep their length marker (that is what
 * makes 0x1A45DFA3 the number everyone quotes); sizes have it stripped.
 * `unknown` is EBML's all-ones size, used by live muxers that cannot know the
 * length of what they are still writing.
 */
function readVint(buffer, pos, stripMarker) {
  if (pos >= buffer.length) return null;
  const first = buffer[pos];
  if (first === 0) return null; // >8-byte vint: not something we produce or read
  let length = 1;
  let mask = 0x80;
  while (!(first & mask)) {
    mask >>= 1;
    length += 1;
  }
  if (pos + length > buffer.length) return null;
  let value = stripMarker ? first & (mask - 1) : first;
  let unknown = stripMarker ? (first & (mask - 1)) === mask - 1 : false;
  for (let i = 1; i < length; i += 1) {
    const byte = buffer[pos + i];
    value = value * 256 + byte;
    if (byte !== 0xff) unknown = false;
  }
  return { value, length, unknown };
}

function readUint(buffer, start, end) {
  let value = 0;
  for (let i = start; i < end && i < buffer.length; i += 1) value = value * 256 + buffer[i];
  return value;
}

function scanEbml(buffer, start, end, state) {
  let pos = start;
  while (pos < end) {
    const id = readVint(buffer, pos, false);
    if (!id) return;
    let cursor = pos + id.length;
    const size = readVint(buffer, cursor, true);
    if (!size) return;
    cursor += size.length;
    // An unknown-size master (a still-being-written Cluster, or the Segment of
    // a stream) runs to the end of what we have; parse it transparently and
    // stop, since there is no sibling boundary to come back to.
    const contentEnd = size.unknown ? end : Math.min(end, cursor + size.value);
    if (MASTERS.has(id.value)) {
      scanEbml(buffer, cursor, contentEnd, state);
      if (size.unknown) return;
    } else if (id.value === EL.TIMECODE_SCALE) {
      const scale = readUint(buffer, cursor, contentEnd);
      if (scale > 0) state.timecodeScale = scale;
    } else if (id.value === EL.DURATION) {
      const bytes = contentEnd - cursor;
      if (bytes === 4) state.duration = buffer.readFloatBE(cursor);
      else if (bytes === 8) state.duration = buffer.readDoubleBE(cursor);
    } else if (id.value === EL.CLUSTER_TIMECODE) {
      state.lastCluster = Math.max(state.lastCluster, readUint(buffer, cursor, contentEnd));
    }
    if (contentEnd <= pos) return; // no forward progress: malformed, give up
    pos = contentEnd;
  }
}

/**
 * How long a WebM runs, in seconds, or null when the file says nothing about it.
 *
 * Two sources, because Playwright's own recordVideo output does not always
 * carry a Duration element in Segment/Info (it is muxed while recording):
 *   1. Segment > Info > Duration — exact, when present;
 *   2. the largest Cluster timecode — the start of the last cluster, i.e. a
 *      slight UNDER-estimate. Good enough for a "must be under 5 seconds" gate
 *      and never an over-estimate that would reject a legal clip.
 */
function webmDuration(buffer) {
  const state = { timecodeScale: 1_000_000, duration: null, lastCluster: 0 };
  scanEbml(buffer, 0, buffer.length, state);
  const scaleSeconds = state.timecodeScale / 1_000_000_000;
  if (state.duration != null && Number.isFinite(state.duration) && state.duration > 0) {
    return { seconds: state.duration * scaleSeconds, source: 'duration' };
  }
  if (state.lastCluster > 0) {
    return { seconds: state.lastCluster * scaleSeconds, source: 'clusters' };
  }
  return null;
}

// ----------------------------------------------------------------- the rules

/** Shape only — no filesystem. Throws with a message naming the fragment. */
function validateMediaShape(where, media) {
  if (!media || typeof media !== 'object' || Array.isArray(media)) {
    throw new Error(`${where}: "media" must be an object`);
  }
  const known = ['poster', 'video', 'alt'];
  const unknown = Object.keys(media).filter((k) => !known.includes(k));
  if (unknown.length) throw new Error(`${where}: unknown media field(s): ${unknown.join(', ')}`);

  if (typeof media.poster !== 'string' || !media.poster.trim()) {
    throw new Error(
      `${where}: "media.poster" is required whenever "media" is present — a still always is, ` +
        'a clip never: CHANGELOG.md is markdown, an older browser may not decode WebM, and ' +
        'prefers-reduced-motion must have something to show'
    );
  }
  if (!posterPattern.test(media.poster)) {
    throw new Error(
      `${where}: "media.poster" must be a path like "${MEDIA_DIR}/<slug>.png" — PNG only, in that directory ` +
        `(got "${media.poster}")`
    );
  }
  if (media.video !== undefined && (typeof media.video !== 'string' || !videoPattern.test(media.video))) {
    throw new Error(
      `${where}: "media.video" must be a path like "${MEDIA_DIR}/<slug>.webm" — WebM only, never a GIF ` +
        `(got ${JSON.stringify(media.video)})`
    );
  }
  if (!media.alt || typeof media.alt !== 'object' || Array.isArray(media.alt)) {
    throw new Error(`${where}: "media.alt" must be an object with all of ${LOCALES.join('/')}`);
  }
  for (const locale of LOCALES) {
    const text = media.alt[locale];
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error(`${where}: "media.alt.${locale}" must be a non-empty string (all of ${LOCALES.join('/')} are required together)`);
    }
  }
  const extraLocales = Object.keys(media.alt).filter((k) => !LOCALES.includes(k));
  if (extraLocales.length) throw new Error(`${where}: unknown media.alt locale(s): ${extraLocales.join(', ')}`);
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(0)} KB`;
}

/**
 * The files themselves: they exist, they are what their extension claims, they
 * are within the caps, and a clip is under five seconds.
 *
 * Returns the media block with the poster's intrinsic `width`/`height` added,
 * so the page can reserve the space before the image loads.
 *
 * When public/ is not present at all (a partial checkout, a Docker stage that
 * copied only the source), the asset checks are SKIPPED and the shape-checked
 * block is returned unchanged: a build must still be able to derive its version.
 * CI always runs where public/ exists, which is where the gate has to hold.
 */
function resolveMediaAssets(repoRoot, where, media) {
  validateMediaShape(where, media);
  const publicRoot = path.join(repoRoot, PUBLIC_DIR);
  if (!existsSync(publicRoot)) return { ...media };

  const posterPath = path.join(publicRoot, media.poster);
  if (!existsSync(posterPath)) {
    throw new Error(`${where}: media.poster not found — expected ${PUBLIC_DIR}/${media.poster}`);
  }
  const posterBytes = statSync(posterPath).size;
  if (posterBytes > MAX_POSTER_BYTES) {
    throw new Error(
      `${where}: media.poster is ${kb(posterBytes)}, over the ${kb(MAX_POSTER_BYTES)} cap — ` +
        'capture the element (locator.screenshot()), not the whole page'
    );
  }
  const size = pngSize(readFileSync(posterPath));
  if (!size) throw new Error(`${where}: media.poster is not a readable PNG (${PUBLIC_DIR}/${media.poster})`);

  const resolved = { ...media, width: size.width, height: size.height };

  if (media.video) {
    const videoPath = path.join(publicRoot, media.video);
    if (!existsSync(videoPath)) {
      throw new Error(`${where}: media.video not found — expected ${PUBLIC_DIR}/${media.video}`);
    }
    const videoBytes = statSync(videoPath).size;
    if (videoBytes > MAX_VIDEO_BYTES) {
      throw new Error(`${where}: media.video is ${kb(videoBytes)}, over the ${kb(MAX_VIDEO_BYTES)} cap`);
    }
    const duration = webmDuration(readFileSync(videoPath));
    if (!duration) {
      throw new Error(
        `${where}: could not read a duration from ${PUBLIC_DIR}/${media.video} — ` +
          'is it a WebM produced by Playwright\'s recordVideo?'
      );
    }
    if (duration.seconds > MAX_VIDEO_SECONDS + DURATION_EPSILON) {
      throw new Error(
        `${where}: media.video runs ${duration.seconds.toFixed(2)}s, over the ${MAX_VIDEO_SECONDS}s cap ` +
          '(WCAG 2.2.2: longer auto-playing motion would need a pause control) — keep the capture test shorter'
      );
    }
  }

  return resolved;
}

module.exports = {
  MEDIA_DIR,
  PUBLIC_DIR,
  LOCALES,
  MAX_POSTER_BYTES,
  MAX_VIDEO_BYTES,
  MAX_VIDEO_SECONDS,
  pngSize,
  webmDuration,
  validateMediaShape,
  resolveMediaAssets,
};
