// The pure half of thread catch-up and suggested replies (#2048) — what is
// sent and in which language. No provider, no database: the route reads the
// rows, this shapes them, src/lib/aiThread.ts talks to the provider, and
// scripts/test/thread-ai-rules.test.mjs pins it.

export const REPLY_TONES = ['brief', 'warm', 'formal'] as const;
export type ReplyTone = (typeof REPLY_TONES)[number];

/** How many of the latest messages a catch-up or a reply is grounded in. */
export const THREAD_AI_MESSAGES = 60;
/** The transcript's character budget — the newest lines win. */
export const THREAD_AI_MAX_CHARS = 16_000;

export interface TranscriptMessage {
  id: string;
  senderId: string;
  body: string;
  createdAt: Date | string;
}

/**
 * The transcript sent to the provider: `YYYY-MM-DD HH:MM · Name: text`, oldest
 * first, keeping the NEWEST lines that fit the budget (a long thread loses its
 * beginning, never its end — the end is what a catch-up and a reply are about).
 * Empty bodies (an attachment-only message) are named as such, not dropped,
 * so the order of the conversation stays readable.
 */
export function buildTranscript(
  messagesNewestFirst: TranscriptMessage[],
  nameOf: (senderId: string) => string,
  maxChars = THREAD_AI_MAX_CHARS,
): string {
  const lines: string[] = [];
  let used = 0;
  for (const m of messagesNewestFirst) {
    const at = new Date(m.createdAt).toISOString().slice(0, 16).replace('T', ' ');
    const text = m.body.replace(/\s+/g, ' ').trim() || '[attachment]';
    const line = `${at} · ${nameOf(m.senderId)}: ${text}`;
    if (used + line.length + 1 > maxChars) {
      if (lines.length === 0) lines.push(line.slice(0, maxChars));
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.reverse().join('\n');
}

const LANGUAGES: Record<string, string> = { en: 'English', tr: 'Turkish', de: 'German' };

/** A locale key → the language name the prompt asks for; unknown → English. */
export function languageName(locale: string | null | undefined): string {
  return LANGUAGES[(locale ?? '').slice(0, 2).toLowerCase()] ?? 'English';
}

/**
 * The language a suggested reply is written in: the RECIPIENT's (#2048) — on
 * a 1:1 thread the one other person's preferred language. A group room has no
 * single recipient, so it falls back to the author's own language, which is
 * what they would type in anyway.
 */
export function replyLocale(recipients: { preferredLanguage: string | null }[], authorLocale: string): string {
  if (recipients.length === 1 && recipients[0].preferredLanguage) return recipients[0].preferredLanguage;
  return authorLocale;
}
