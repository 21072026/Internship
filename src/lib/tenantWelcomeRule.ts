// The tenant welcome page's rules (#1664). Pure and client-safe; unit-tested in
// scripts/test/tenant-welcome.test.mjs.
//
// The page is PUBLIC and its text is TENANT-WRITTEN, so it is never markup:
// the body is split into paragraphs and lines here and rendered as React text
// nodes, which escape everything. A `<script>` in the body is shown as the
// characters `<script>`. Never route this text through dangerouslySetInnerHTML
// or a Markdown renderer — that would turn every tenant admin into an author
// of script on a page anybody can be sent to.

/** A welcome page exists when its title has content; the body is optional. */
export function hasWelcome(row: { welcomeTitle?: string | null } | null | undefined): boolean {
  return typeof row?.welcomeTitle === 'string' && row.welcomeTitle.trim().length > 0;
}

/**
 * The body as paragraphs of lines: a blank line starts a paragraph, a single
 * newline is a line break inside one. Windows line endings are folded, blank
 * paragraphs dropped, and each line trimmed at its end only (leading spaces
 * can be deliberate indentation and are harmless as text).
 */
export function welcomeParagraphs(body: string | null | undefined): string[][] {
  if (typeof body !== 'string') return [];
  return body
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((p) => p.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== ''))
    .filter((lines) => lines.length > 0);
}
