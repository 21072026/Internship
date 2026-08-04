// Opening a small window that floats above everything — including other
// applications — and copying the app's styles into it (#1057).
//
// Document Picture-in-Picture (Chrome/Edge 116+, desktop) is the only web API
// that gives an always-on-top window with a real DOM. Where it is missing
// (Safari, Firefox, mobile) we fall back to a plain popup: same document, same
// autosave, just not on top. The caller is told which one it got so the UI can
// say so rather than leaving the user wondering.

export type FloatingWindowKind = 'pip' | 'popup';

export interface FloatingWindow {
  kind: FloatingWindowKind;
  win: Window;
  mount: HTMLElement;
}

// Feature test, not a user-agent sniff: the API either exists or it doesn't.
export function supportsDocumentPip(): boolean {
  return typeof window !== 'undefined' && 'documentPictureInPicture' in window;
}

interface DocumentPipApi {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
  window: Window | null;
}

function pipApi(): DocumentPipApi | null {
  return (window as unknown as { documentPictureInPicture?: DocumentPipApi }).documentPictureInPicture ?? null;
}

// A PiP document inherits no styles at all, so every stylesheet has to be
// carried over by hand. Same-origin sheets can be re-serialised from their
// cssRules; the rest (and anything that throws on access) are re-linked by href.
function copyStyles(target: Document) {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const css = Array.from(sheet.cssRules)
        .map((rule) => rule.cssText)
        .join('\n');
      const style = target.createElement('style');
      style.textContent = css;
      target.head.appendChild(style);
    } catch {
      if (sheet.href) {
        const link = target.createElement('link');
        link.rel = 'stylesheet';
        link.href = sheet.href;
        target.head.appendChild(link);
      }
    }
  }
  // The theme is a class on <html>, and the PiP document has its own.
  target.documentElement.className = document.documentElement.className;
}

function prepare(win: Window, kind: FloatingWindowKind): FloatingWindow {
  copyStyles(win.document);
  win.document.body.className = 'bg-white dark:bg-gray-900';
  const mount = win.document.createElement('div');
  mount.id = 'floating-root';
  win.document.body.appendChild(mount);
  return { kind, win, mount };
}

/**
 * MUST be called synchronously from a user gesture handler. Both APIs require
 * transient activation, and awaiting anything first (a fetch, for instance)
 * spends it — the window then silently fails to open. Start the room *after*
 * this call, not before.
 */
export async function openFloatingWindow(
  opts: { width?: number; height?: number; title?: string } = {}
): Promise<FloatingWindow | null> {
  const width = opts.width ?? 380;
  const height = opts.height ?? 480;

  const api = pipApi();
  if (api) {
    // One PiP window per browser: reuse the open one instead of failing.
    if (api.window) {
      try {
        api.window.close();
      } catch {
        /* already gone */
      }
    }
    try {
      const win = await api.requestWindow({ width, height });
      if (opts.title) win.document.title = opts.title;
      return prepare(win, 'pip');
    } catch {
      // Denied or unavailable — fall through to the popup.
    }
  }

  const win = window.open('', '', `popup=yes,width=${width},height=${height}`);
  // Blocked by the popup blocker, or no window at all.
  if (!win) return null;
  if (opts.title) win.document.title = opts.title;
  return prepare(win, 'popup');
}
