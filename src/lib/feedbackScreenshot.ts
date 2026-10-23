// One-click screenshot for a bug report (#3130): the page's DOM rendered to an
// image in the browser (modern-screenshot), so no permission picker opens.
// What the person is looking at — the visible viewport, cropped from a render
// of the document — never the feedback panel itself, and never a secret:
// password fields, one-time-code / card inputs and anything marked
// `data-private` or `.rr-block` are painted over in the copy before rendering.
// The image stays in memory until the person presses Send.

import { withRecordingPaused } from '@/lib/feedbackCollector';

/** Anything inside this attribute is left out of the capture (the widget). */
export const FEEDBACK_UI_ATTR = 'data-feedback-ui';

const SECRET_SELECTOR = [
  'input[type="password"]',
  'input[autocomplete^="cc-"]',
  'input[autocomplete="one-time-code"]',
  '[data-private]',
  '.rr-block',
].join(',');

function maskClone(node: Node) {
  if (!(node instanceof HTMLElement) || !node.matches(SECRET_SELECTOR)) return;
  if (node instanceof HTMLInputElement) {
    node.value = '';
    node.setAttribute('value', '');
  }
  node.style.setProperty('background', '#9ca3af', 'important');
  node.style.setProperty('color', 'transparent', 'important');
  node.style.setProperty('text-shadow', 'none', 'important');
  for (const child of Array.from(node.children)) child.remove();
}

export async function captureViewport(): Promise<Blob> {
  const { domToCanvas } = await import('modern-screenshot');
  return withRecordingPaused(async () => {
    const root = document.documentElement;
    const full = await domToCanvas(root, {
      scale: 1,
      backgroundColor: getComputedStyle(document.body).backgroundColor || '#ffffff',
      filter: (el) => !(el instanceof Element && el.hasAttribute(FEEDBACK_UI_ATTR)),
      onCloneEachNode: maskClone,
      timeout: 5000,
    });
    const w = Math.min(window.innerWidth, full.width);
    const h = Math.min(window.innerHeight, full.height);
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    out.getContext('2d')!.drawImage(full, window.scrollX, window.scrollY, w, h, 0, 0, w, h);
    return new Promise<Blob>((resolve, reject) =>
      out.toBlob((b) => (b ? resolve(b) : reject(new Error('empty capture'))), 'image/jpeg', 0.85),
    );
  });
}
