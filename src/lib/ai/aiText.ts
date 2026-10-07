// What model output is allowed to be on screen (#2026) — pure, client-safe,
// unit-tested in scripts/test/ai-untrusted.test.mjs. The renderer is
// src/components/ai/AiText.tsx; this is the rule it applies.
//
// Model text is untrusted output: a crafted CV can steer what comes back. So
// generated text is only ever a React text node — never HTML, never markdown
// turned into markup, never an anchor — and before it gets there:
//   • control characters go (except newline and tab), CRLF becomes LF;
//   • bidirectional overrides/isolates go (U+202A–202E, U+2066–2069): they can
//     make text read differently from what it is ("Trojan Source");
//   • it is capped, so a runaway reply cannot flood the page.

export const AI_TEXT_MAX_CHARS = 8_000;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const BIDI = /[‪-‮⁦-⁩]/g;

export function sanitizeAiText(text: string | null | undefined, max: number = AI_TEXT_MAX_CHARS): string {
  const clean = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, '')
    .replace(BIDI, '');
  return clean.length > max ? `${clean.slice(0, max).trimEnd()}…` : clean;
}
