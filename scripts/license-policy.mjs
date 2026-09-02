// Third-party licence policy for this repository (#2059).
//
// Two questions have to be answerable about every dependency we ship, and they
// are NOT the same question:
//
//   1. May we distribute it inside a program licensed AGPL-3.0-or-later?
//   2. May the sole rights holder also sell a commercial licence on top —
//      i.e. grant somebody the right to use this program under terms that are
//      not the AGPL?
//
// Question 2 is the one that catches people out. GPL-3.0 and AGPL-3.0
// dependencies pass question 1 happily — they are the same family — but they
// make question 2 impossible, because we cannot sublicense somebody else's
// copyleft code under proprietary terms. This project is dual-licensed
// (docs/legal/licensing-strategy.md), so a dependency that quietly kills the
// commercial grant is a business problem, not a paperwork problem, and it must
// fail the build the day it enters the tree rather than the day a lawyer reads
// the dependency list.
//
// The sole rights holder is Mehmet Erşahin, a natural person. No company holds
// the IP; nothing generated from this file may say otherwise.
//
// Not legal advice. This encodes the well-understood cases so that a NEW,
// unclassified licence stops the build and gets a human decision, which is the
// only part software can usefully do here.

/**
 * Verdict tiers, ordered best to worst. `blocks` decides whether the check
 * fails; the order decides how an `OR` expression is resolved (we may pick any
 * one disjunct, so we pick the best) and how an `AND` is (every term binds, so
 * the worst wins).
 */
export const VERDICTS = [
  {
    key: 'permissive',
    label: 'ok',
    blocks: false,
    summary: 'Permissive. No obligation beyond keeping the copyright notice.',
  },
  {
    key: 'attribution',
    label: 'ok · attribution',
    blocks: false,
    summary:
      'Permissive with an explicit attribution requirement (usually a data set rather than code). Satisfied by this inventory plus the notice shipped inside the package.',
  },
  {
    key: 'weak-copyleft',
    label: 'ok · weak copyleft',
    blocks: false,
    summary:
      'File- or library-level copyleft (LGPL, MPL, EPL). Compatible with both the AGPL distribution and the commercial grant as long as the package is shipped unmodified and its own source stays available. Modifying one of these in place is what would change the answer.',
  },
  {
    key: 'allowlisted',
    label: 'ok · allowlisted',
    blocks: false,
    summary:
      'The declared string is not a resolvable SPDX expression, and the real licence was established by hand. Every entry carries its reason in scripts/license-policy.mjs.',
  },
  {
    key: 'blocks-commercial',
    label: 'FAIL · blocks the commercial grant',
    blocks: true,
    summary:
      'Strong copyleft, in several cases with a network clause. Distributing under AGPL-3.0-or-later would be fine; selling a non-AGPL licence on top of it would not, because we cannot sublicense somebody else’s copyleft code under proprietary terms.',
  },
  {
    key: 'incompatible',
    label: 'FAIL · incompatible with AGPL-3.0-or-later',
    blocks: true,
    summary:
      'Cannot be combined with this codebase at all: either a copyleft licence AGPL-3.0 is not compatible with, or a source-available/non-commercial licence that is not free software.',
  },
  {
    key: 'unknown',
    label: 'FAIL · unknown licence',
    blocks: true,
    summary:
      'No licence could be resolved. An unlicensed dependency grants no rights at all, which is strictly worse than a copyleft one — silence is not permission.',
  },
];

const RANK = new Map(VERDICTS.map((verdict, index) => [verdict.key, index]));
const BY_KEY = new Map(VERDICTS.map((verdict) => [verdict.key, verdict]));

export const verdict = (key) => BY_KEY.get(key);
export const worse = (a, b) => (RANK.get(a) >= RANK.get(b) ? a : b);
export const better = (a, b) => (RANK.get(a) <= RANK.get(b) ? a : b);

/**
 * SPDX identifier -> verdict. Deliberately an allowlist of identifiers rather
 * than a pattern: a licence nobody has classified must reach a human, and the
 * only reliable way to guarantee that is for the default to be `unknown`.
 *
 * Keys are matched case-insensitively and with any trailing `+`
 * ("or later") stripped — `LGPL-3.0+` and `LGPL-3.0-or-later` are the same
 * answer for our purposes.
 */
export const SPDX = {
  // --- permissive -----------------------------------------------------------
  '0BSD': 'permissive',
  'AFL-2.1': 'permissive',
  'Apache-2.0': 'permissive',
  'Artistic-2.0': 'permissive',
  'BlueOak-1.0.0': 'permissive',
  'BSD-2-Clause': 'permissive',
  'BSD-3-Clause': 'permissive',
  'BSD-3-Clause-Clear': 'permissive',
  'BSL-1.0': 'permissive',
  'CC0-1.0': 'permissive',
  'ISC': 'permissive',
  'MIT': 'permissive',
  'MIT-0': 'permissive',
  'PSF-2.0': 'permissive',
  'Python-2.0': 'permissive',
  'Unlicense': 'permissive',
  'W3C': 'permissive',
  'WTFPL': 'permissive',
  'Zlib': 'permissive',

  // --- permissive, attribution required ------------------------------------
  'CC-BY-3.0': 'attribution',
  'CC-BY-4.0': 'attribution',

  // --- weak (file/library level) copyleft -----------------------------------
  'CDDL-1.0': 'weak-copyleft',
  'CDDL-1.1': 'weak-copyleft',
  'EPL-1.0': 'weak-copyleft',
  'EPL-2.0': 'weak-copyleft',
  'LGPL-2.0': 'weak-copyleft',
  'LGPL-2.1': 'weak-copyleft',
  'LGPL-3.0': 'weak-copyleft',
  'MPL-1.1': 'weak-copyleft',
  'MPL-2.0': 'weak-copyleft',

  // --- strong copyleft: fine under AGPL, fatal to the commercial grant ------
  'AGPL-3.0': 'blocks-commercial',
  'CC-BY-SA-4.0': 'blocks-commercial',
  'EUPL-1.1': 'blocks-commercial',
  'EUPL-1.2': 'blocks-commercial',
  'GPL-3.0': 'blocks-commercial',
  'OSL-3.0': 'blocks-commercial',
  'SSPL-1.0': 'blocks-commercial',

  // --- outright incompatible ------------------------------------------------
  // GPL-2.0-only cannot be combined with AGPL-3.0 at all: neither licence
  // permits the other's terms and GPL-2.0-only has no upgrade path. The
  // `-or-later` variant is a genuinely different answer — the recipient may
  // take GPL-3.0 instead, which AGPL-3.0 is compatible with — so it is a
  // commercial-grant problem rather than an incompatibility, and it is listed
  // above. The bare, suffix-less `GPL-2.0` is ambiguous in npm metadata and
  // resolveId() reads it as the stricter of the two.
  'GPL-2.0-only': 'incompatible',
  'GPL-2.0-or-later': 'blocks-commercial',
  'BUSL-1.1': 'incompatible',
  'Elastic-2.0': 'incompatible',
  'CC-BY-NC-4.0': 'incompatible',
  'CC-BY-NC-SA-4.0': 'incompatible',
  'CC-BY-ND-4.0': 'incompatible',
  'LicenseRef-scancode-commons-clause': 'incompatible',
  'UNLICENSED': 'incompatible',
};

/**
 * Hand-resolved packages, keyed by `name` or `name@version`.
 *
 * This is the licence equivalent of docs/security-exceptions.md, and it follows
 * the same rule: the reason IS the entry. `reason` is required and is rendered
 * verbatim into docs/legal/third-party-licenses.md, so an allowlisting nobody
 * could justify in a sentence never gets written in the first place.
 *
 * `spdx` is what we concluded the licence actually is, from reading the
 * LICENSE file shipped in the package — not a guess from the package name.
 */
export const ALLOWLIST = {
  'duck@0.1.12': {
    spdx: 'BSD-2-Clause',
    declared: 'BSD',
    reason:
      'Declares the bare, non-SPDX string "BSD", which by itself is unresolvable — "BSD" covers everything from 0BSD to the 4-clause advertising variant. The LICENSE file shipped in the package is verbatim BSD-2-Clause (copyright 2013 Michael Williamson: the two redistribution conditions and the warranty disclaimer, no advertising clause, no non-endorsement clause), so the licence is permissive and compatible with both AGPL distribution and the commercial grant. Reached only through `mammoth` → `lop` → `duck`, the .docx parser used for CV text extraction. Re-read the LICENSE file if the version changes; the key is version-pinned so a bump forces exactly that.',
  },
};

/**
 * Parse an SPDX licence expression into a verdict.
 *
 * Handles what actually appears in npm metadata: bare ids, `OR` / `AND`,
 * parentheses, a trailing `+`, `WITH <exception>`, and the `SEE LICENSE IN …`
 * escape hatch (which is not a licence — it is a request to go and read
 * something, so it resolves to `unknown`).
 *
 * `OR` takes the best branch because a disjunctive licence lets the recipient
 * choose, and we choose. `AND` takes the worst because every term binds.
 * `GPL-2.0-or-later` is deliberately *not* the same as `GPL-2.0-only`: the
 * "or later" option lets a recipient take GPL-3.0, which AGPL-3.0 is
 * compatible with — so it is a commercial-grant problem, not an
 * incompatibility.
 */
export function parseSpdx(expression) {
  if (typeof expression !== 'string' || !expression.trim()) return 'unknown';
  const text = expression.trim();
  if (/^see\s+licen[cs]e/i.test(text)) return 'unknown';

  const tokens = text
    .replace(/\(/g, ' ( ')
    .replace(/\)/g, ' ) ')
    .split(/\s+/)
    .filter(Boolean);

  let index = 0;
  const peek = () => tokens[index];

  // term := '(' expr ')' | id [ 'WITH' exception ]
  const term = () => {
    if (peek() === '(') {
      index += 1;
      const inner = expr();
      if (peek() === ')') index += 1;
      return inner;
    }
    const id = tokens[index];
    index += 1;
    if (id === undefined) return 'unknown';
    // A licence exception ("GPL-2.0 WITH Classpath-exception-2.0") always
    // loosens the licence, never tightens it — but by how much depends on the
    // exception, so it is not something to guess at. Keep the base verdict.
    if (peek() && peek().toUpperCase() === 'WITH') index += 2;
    return resolveId(id);
  };

  // expr := term { ('AND' | 'OR') term }   — no precedence, npm never nests
  // deeper than one level and SPDX's own precedence would not change any real
  // answer here.
  const expr = () => {
    let result = term();
    while (peek() && ['AND', 'OR'].includes(peek().toUpperCase())) {
      const operator = tokens[index].toUpperCase();
      index += 1;
      const right = term();
      result = operator === 'OR' ? better(result, right) : worse(result, right);
    }
    return result;
  };

  return expr();
}

function resolveId(rawId) {
  const id = rawId.replace(/\+$/, '');
  const orLater = rawId.endsWith('+') || /-or-later$/i.test(id);
  const base = id.replace(/-(or-later|only)$/i, '');

  // `Foo-1.0+` and `Foo-1.0-or-later` are the same licence written two ways, so
  // try the canonical spelling too before falling back to the bare id.
  const candidates = [id, orLater ? `${base}-or-later` : null, base].filter(Boolean);
  for (const candidate of candidates) {
    const match = Object.keys(SPDX).find((key) => key.toLowerCase() === candidate.toLowerCase());
    if (match) return SPDX[match];
  }

  // Bare `GPL-2.0`, no suffix: npm metadata is ambiguous and the two readings
  // have different answers, so take the stricter one rather than guessing in
  // our own favour.
  if (/^GPL-2\.0$/i.test(base)) return 'incompatible';
  return 'unknown';
}

/**
 * Classify one package. Returns `{ verdict, spdx, source }` where `source`
 * says how the answer was reached, so the inventory can show its work.
 */
export function classify({ name, version, license }) {
  const allow = ALLOWLIST[`${name}@${version}`] || ALLOWLIST[name];
  if (allow) {
    return {
      verdict: parseSpdx(allow.spdx) === 'unknown' ? 'unknown' : 'allowlisted',
      spdx: allow.spdx,
      declared: allow.declared ?? license ?? '(none declared)',
      reason: allow.reason,
      source: 'allowlist',
    };
  }
  return {
    verdict: parseSpdx(license),
    spdx: license || '(none declared)',
    declared: license || '(none declared)',
    source: license ? 'declared' : 'missing',
  };
}
