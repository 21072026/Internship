import { sanitizeAiText, AI_TEXT_MAX_CHARS } from '@/lib/ai/aiText';

/**
 * The one way model-generated prose reaches the screen (#2026): a plain text
 * node with its line breaks kept — no `dangerouslySetInnerHTML`, no markdown
 * renderer, no auto-linking, so a reply steered by a crafted CV cannot inject
 * markup or a clickable link. A URL in the text stays inert text. The ✨
 * marker (#2034) stays the caller's, next to it (`AiBadge`), because some
 * surfaces put it in a header row.
 *
 * Every AI output surface uses it; scripts/test/ai-untrusted.test.mjs fails
 * when one renders generated text another way.
 */
export function AiText({
  text,
  max = AI_TEXT_MAX_CHARS,
  className = '',
  testId,
  as: Tag = 'div',
}: {
  text: string | null | undefined;
  max?: number;
  className?: string;
  testId?: string;
  as?: 'div' | 'p';
}) {
  return (
    <Tag className={`whitespace-pre-wrap break-words ${className}`} data-testid={testId} data-ai-text="">
      {sanitizeAiText(text, max)}
    </Tag>
  );
}
