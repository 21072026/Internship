/**
 * The one registry of keyboard shortcuts (#2079).
 *
 * Both the handler that listens for a key and the `?` help sheet that lists it
 * read this file, so the sheet cannot claim a binding the app does not have.
 * Adding a shortcut means adding an entry here *and* a `shortcuts.entries.<id>`
 * string in all three locales — TypeScript's dictionary parity check makes the
 * second half impossible to forget.
 */

/** Placeholder for the platform modifier: ⌘ on macOS, Ctrl everywhere else. */
export const MOD = 'Mod';

export type ShortcutId =
  | 'openPalette'
  | 'openShortcuts'
  | 'moveSelection'
  | 'firstLast'
  | 'openSelection'
  | 'dismiss';

export interface ShortcutDefinition {
  id: ShortcutId;
  /**
   * Alternative chords, each an ordered list of keys pressed together.
   * `[['ArrowUp'], ['ArrowDown']]` renders as "↑ / ↓"; `[[MOD, 'K']]` as "⌘ K".
   */
  chords: string[][];
}

export const SHORTCUTS: ShortcutDefinition[] = [
  { id: 'openPalette', chords: [[MOD, 'K']] },
  { id: 'openShortcuts', chords: [['?']] },
  { id: 'moveSelection', chords: [['↑'], ['↓']] },
  { id: 'firstLast', chords: [['Home'], ['End']] },
  { id: 'openSelection', chords: [['Enter']] },
  { id: 'dismiss', chords: [['Esc']] },
];

/** ⌘ on Apple hardware, Ctrl on Windows/Linux. */
export function modifierLabel(isMac: boolean): string {
  return isMac ? '⌘' : 'Ctrl';
}

/** Resolves the `Mod` placeholder for the current platform. */
export function resolveChords(chords: string[][], isMac: boolean): string[][] {
  return chords.map((chord) => chord.map((key) => (key === MOD ? modifierLabel(isMac) : key)));
}

/**
 * Best-effort platform sniff. Only ever used to pick a *label*, never to decide
 * which key actually opens something (both Meta and Control are accepted), so a
 * wrong guess is cosmetic. Call it from an effect: `navigator` does not exist
 * during SSR and a server/client disagreement would be a hydration mismatch.
 */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const source = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`;
  return /Mac|iPhone|iPad|iPod/i.test(source);
}

/**
 * True when the caret sits somewhere a bare keystroke is content, not a command.
 * Global shortcuts must stay silent there — `?` in a message body is a question
 * mark, and ⌘K in a text field belongs to the browser/OS.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
