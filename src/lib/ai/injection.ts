// The prompt-injection tripwire (#2026) — pure, unit-tested in
// scripts/test/ai-untrusted.test.mjs.
//
// It FLAGS, it never blocks. A false positive that refused a real CV ("I was
// asked to ignore the previous design and rewrite it…") would be worse than a
// logged one, and the fence plus UNTRUSTED_DATA_RULE (src/lib/ai/untrusted.ts)
// are what actually stand between the text and the model's behaviour. A hit
// is stamped on the call's `AiUsage.flags`, so an operator can see that
// someone tried (#2030 surfaces it on /admin/ai).
//
// The patterns are deliberately the well-known steering shapes in EN/DE/TR —
// a cheap, explainable pre-flight, not a classifier.

export type InjectionSignal = 'instruction_override' | 'role_reassignment' | 'prompt_exfiltration' | 'encoded_blob';

const PATTERNS: Record<InjectionSignal, RegExp[]> = {
  instruction_override: [
    /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|preceding|all|any|your|the)\b[^.\n]{0,25}\b(?:instructions?|prompts?|rules|directions|guidelines|directives)\b/i,
    /\b(?:ignorier\w*|vergiss|missachte\w*|übergeh\w*)\b[^.\n]{0,20}\b(?:alle|vorherigen|vorigen|obigen|bisherigen|deine)\b[^.\n]{0,20}\b(?:anweisung\w*|instruktion\w*|regeln|vorgaben)\b/i,
    /(?:önceki|yukarıdaki|tüm|bütün)\s+(?:talimat|komut|kural|yönerge)\w*[^.\n]{0,25}(?:yok\s*say|unut|görmezden\s*gel|dikkate\s*alma)/i,
  ],
  role_reassignment: [
    /\b(?:you are now|from now on,? you|act as (?:an?|the) (?:ai|assistant|system|admin)|pretend (?:to be|you are)|new instructions?\s*:)/i,
    /(?:^|\n)\s*(?:system|assistant|developer)\s*:/i,
    /<\/?(?:system|assistant|developer)>|\[\/?INST\]|<\|im_(?:start|end)\|>/i,
    /\b(?:du bist (?:jetzt|ab sofort)|ab jetzt bist du|neue anweisung\w*\s*:)/i,
    /\b(?:artık sen|bundan sonra sen|yeni talimat\w*\s*:)/i,
  ],
  prompt_exfiltration: [
    /\b(?:reveal|print|show|output|repeat|display|tell me|leak|dump)\b[^.\n]{0,40}\b(?:system prompt|your (?:instructions|prompt|rules)|the prompt|initial instructions|hidden instructions)\b/i,
    /\b(?:zeig|gib|nenne|wiederhol|verrat|ausgeb)\w*\b[^.\n]{0,40}(?:system-?prompt|systemanweisung\w*|deine anweisungen)/i,
    /sistem\s*(?:istemini|promptunu|talimatlarını)[^.\n]{0,30}(?:göster|yaz|söyle|paylaş|tekrarla)/i,
  ],
  // Long base64 runs: a classic way to smuggle an instruction past a reader.
  encoded_blob: [/[A-Za-z0-9+/]{200,}={0,2}/],
};

/** The signals present in `text`, in a stable order; empty when none. */
export function injectionSignals(text: string): InjectionSignal[] {
  if (!text) return [];
  return (Object.keys(PATTERNS) as InjectionSignal[]).filter((k) => PATTERNS[k].some((re) => re.test(text)));
}

/** The comma-joined form `AiUsage.flags` stores (VARCHAR(191)); null when there is nothing to record. */
export function flagsColumn(signals: readonly string[]): string | null {
  const unique = [...new Set(signals)].sort();
  return unique.length ? unique.join(',').slice(0, 191) : null;
}
