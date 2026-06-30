// Minimal, dependency-free renderer for the constrained markdown used by our
// document templates: #/##/### headings, **bold**, "- " bullets, "[ ]/[x]"
// checkboxes, and paragraphs. Input is escaped first, so it is safe to inject.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function inline(s: string): string {
  // **bold** → <strong>. Run after escaping.
  return escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

/** Render the template markdown subset to an HTML string. */
export function templateToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let listOpen = false;
  const closeList = () => { if (listOpen) { out.push('</ul>'); listOpen = false; } };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (line === '') { closeList(); continue; }

    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { closeList(); const lvl = h[1].length; out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`); continue; }

    // Bullet (optionally indented) with optional checkbox.
    const b = /^(\s*)-\s+(.*)$/.exec(line);
    if (b) {
      if (!listOpen) { out.push('<ul>'); listOpen = true; }
      let item = b[2];
      const cb = /^\[( |x|X)\]\s+(.*)$/.exec(item);
      if (cb) {
        const checked = cb[1].toLowerCase() === 'x';
        item = `<span class="cb" aria-hidden="true">${checked ? '☑' : '☐'}</span> ${inline(cb[2])}`;
        out.push(`<li class="task">${item}</li>`);
      } else {
        out.push(`<li>${inline(item)}</li>`);
      }
      continue;
    }

    // Numbered list item → keep as a paragraph with the number preserved.
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

/** Strip markdown markers to a plain-text rendering (for .txt export). */
export function templateToText(md: string): string {
  return md
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l
      .replace(/^(#{1,3})\s+/, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/^(\s*)-\s+\[( |x|X)\]\s+/, '$1• ')
      .replace(/^(\s*)-\s+/, '$1• '))
    .join('\n');
}
