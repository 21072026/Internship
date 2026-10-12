// Action items inside the minutes (#1849): a `- [ ]` / `- [x]` line of a
// SessionNote body, read and written as plain text so the minutes stay a text
// the pair owns — the to-do that mirrors a line is the link, not the storage.
//
// Deliberately dependency-free: the panel renders the list from the body with
// the same functions the server uses to keep the to-do and the line in step,
// and `scripts/test/minutes-action-items.test.mjs` runs it with no build step.

export interface MinutesActionItem {
  /** 0-based line index in the body as given. */
  line: number;
  /** The text after the checkbox, trimmed. */
  text: string;
  done: boolean;
}

// `- [ ] text`, `* [x] text`, `- [X] text`; leading spaces allowed.
const ITEM = /^\s*[-*]\s+\[( |x|X)\]\s+(.*\S)\s*$/;

/** Every action-item line of the body, in order. */
export function parseActionItems(body: string): MinutesActionItem[] {
  const out: MinutesActionItem[] = [];
  body.split('\n').forEach((raw, line) => {
    const m = ITEM.exec(raw);
    if (!m) return;
    out.push({ line, text: m[2].trim(), done: m[1] !== ' ' });
  });
  return out;
}

/** Collapse whitespace and case so a line is found again after a light edit. */
export function normalizeActionText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The action item whose text matches, or null when the line is gone. */
export function findActionItem(body: string, text: string): MinutesActionItem | null {
  const wanted = normalizeActionText(text);
  return parseActionItems(body).find((item) => normalizeActionText(item.text) === wanted) ?? null;
}

/**
 * The body with the matching line's checkbox set to `done`. Returns the body
 * unchanged when the line is gone or already in that state — callers compare
 * to decide whether anything was saved.
 */
export function setActionItemDone(body: string, text: string, done: boolean): string {
  const item = findActionItem(body, text);
  if (!item || item.done === done) return body;
  const lines = body.split('\n');
  lines[item.line] = lines[item.line].replace(/\[( |x|X)\]/, done ? '[x]' : '[ ]');
  return lines.join('\n');
}
