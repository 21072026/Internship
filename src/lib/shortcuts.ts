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

/**
 * WCAG 2.1.4 (Character Key Shortcuts, #2864): `?` is the one binding that is a
 * single printable character, so a speech-input user who says a sentence
 * containing a question mark — or anyone who simply does not want it — can turn
 * it off. The switch sits in the shortcut sheet itself, which stays reachable
 * from the command palette's "Keyboard shortcuts" action, so turning the key off
 * never strands the person. Chords (Mod+K) and non-printing keys are outside the
 * criterion and stay on.
 *
 * Per browser, in localStorage: it is a convenience of this device, not an
 * account setting, and storage that throws (private mode, blocked site data)
 * reads as "on", which is the shipped default.
 */
export const SINGLE_KEY_SHORTCUTS_STORAGE_KEY = 'shortcuts.singleKey';

export function readSingleKeyShortcutsEnabled(): boolean {
  try {
    return window.localStorage.getItem(SINGLE_KEY_SHORTCUTS_STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function writeSingleKeyShortcutsEnabled(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.removeItem(SINGLE_KEY_SHORTCUTS_STORAGE_KEY);
    else window.localStorage.setItem(SINGLE_KEY_SHORTCUTS_STORAGE_KEY, 'off');
  } catch {
    // Storage unavailable: the switch only lasts for this page view.
  }
}
