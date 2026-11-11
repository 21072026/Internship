'use client';

import type { ReactNode } from 'react';

// Renders an offer letter's markdown subset (#1857) — the same subset the PDF
// draws: #/##/### headings, "- " bullets, paragraphs, **bold**. Built as React
// elements, never as HTML: the text is the template author's and the
// candidate's name, and nothing in it is markup.
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <strong key={i}>{part.slice(2, -2)}</strong> : part,
  );
}

export function OfferLetterView({ markdown, testId }: { markdown: string; testId?: string }) {
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length) {
      const items = bullets;
      blocks.push(
        <ul key={`ul-${blocks.length}`} className="list-disc pl-5 space-y-0.5">
          {items.map((b, i) => <li key={i}>{inline(b)}</li>)}
        </ul>,
      );
      bullets = [];
    }
  };
  for (const raw of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    const bullet = /^-\s+(.*)$/.exec(line);
    if (bullet) {
      bullets.push(bullet[1]);
      continue;
    }
    flush();
    if (!line) continue;
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(
        heading[1].length === 1 ? (
          <h3 key={blocks.length} className="text-base font-semibold text-gray-900 dark:text-gray-100">{inline(heading[2])}</h3>
        ) : (
          <h4 key={blocks.length} className="text-sm font-semibold text-gray-900 dark:text-gray-100">{inline(heading[2])}</h4>
        ),
      );
      continue;
    }
    blocks.push(<p key={blocks.length}>{inline(line)}</p>);
  }
  flush();
  return (
    <div className="space-y-2 text-sm text-gray-700 dark:text-gray-300" data-testid={testId}>
      {blocks}
    </div>
  );
}
