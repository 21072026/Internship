// The one rule for a beceri (skill) list: how a typed/pasted blob becomes
// separate skills, and where the list stops (#2314).
//
// WHY THIS EXISTS
//   A mentee filled in their profile from their CV and the admin dashboard's
//   "Yeni Adaylar" card grew a single pill the size of the card:
//     "Java C# / .NET Backend Development REST API / API Development SQL /
//      PostgreSQL Spring Boot FastAPI Python Generative AI / AI Tools Power BI
//      Microsoft Excel Git / GitHub Swagger / API Testing Entity Framework Core
//      Data Analysis Database Management"
//   That is ONE `User.skills` entry, and three separate decisions had to line up
//   to produce it:
//     1. every form split on a comma and nothing else (`skills.split(',')`),
//     2. the field was a single-line <input>, and a browser drops the line
//        breaks out of a multi-line paste — so the newline-separated CV list
//        arrived space-joined, i.e. with no separator left to split on at all,
//     3. no write path bounded the value: `/api/profile` took
//        `z.array(z.string())` with no per-skill length and no count.
//   So: split flexibly (below), never lose the separators (the paste is read
//   from the clipboard by `SkillsField`, not from the input's value), and cap
//   both dimensions in ONE place that the client and every route import.
//
// DEPENDENCY-FREE ON PURPOSE
//   Same reason as `lastContactRule.ts`: this module is unit-tested under
//   `node --test --experimental-strip-types`, which resolves no `@/` alias and
//   no extensionless relative import. That is also why the fold used for
//   duplicate detection is written out here instead of importing
//   `transliterate()` — it needs a comparison key, not a slug.

/**
 * The limits, enforced on BOTH sides. A cap the server holds and the UI does
 * not is a form that fails after the user finished typing; a cap the UI holds
 * and the server does not is not a cap.
 */
export const SKILL_LIMITS = {
  /**
   * Skills per person. Generous: the pasted CV list above is 15 real skills, a
   * senior mentor legitimately lists 25-30. Past 40 the list has stopped being
   * a profile and become a keyword dump that no card, badge row or match query
   * can render usefully.
   */
  maxSkills: 40,
  /**
   * Characters in one skill. The longest genuine entries seen in the data are
   * around 25 ("Entity Framework Core", "Generative AI / AI Tools"); 60 leaves
   * room for a composite label without leaving room for a sentence.
   */
  maxSkillLength: 60,
  /** The count from which the UI turns its counter amber, before the cap. */
  warnSkills: 30,
  /** Where a list/card view clips a label — see `clipSkillLabel`. */
  labelClip: 32,
} as const;

/**
 * Characters that end one skill and start the next.
 *
 * Deliberately NOT here:
 *   `/`  — "SQL / PostgreSQL" and "Generative AI / AI Tools" are how people
 *          write ONE skill; splitting them invents skills nobody claimed.
 *   `&`, `+`, `-` — same ("R&D", "C++", "front-end").
 *   ' '  — a space is inside most real skills ("Data Analysis").
 */
const SEPARATORS = new Set([',', ';', '\n', '\r', '\t', '•', '·', '|']);

/** Bullets and numbering a CV paste carries in front of each line. */
const LIST_MARKER = /^(?:[-*–—•·]+\s*|\d{1,2}[.)]\s+)/;

/** Punctuation left dangling once a line is cut out of prose. */
const TRAILING_PUNCTUATION = /[.,;:·•|\s]+$/;

/**
 * Split raw field text into candidate skills.
 *
 * Paren- and bracket-aware: "Microsoft Office (Word, Excel, PowerPoint)" is one
 * skill, because the comma inside the parentheses belongs to the label. An
 * unbalanced opener cannot swallow the rest of the list — depth is clamped at 0
 * so a stray ")" just closes it.
 */
export function splitSkillInput(raw: string): string[] {
  const out: string[] = [];
  let current = '';
  let depth = 0;

  for (const char of raw) {
    if (char === '(' || char === '[') depth++;
    else if (char === ')' || char === ']') depth = Math.max(0, depth - 1);

    if (depth === 0 && SEPARATORS.has(char)) {
      out.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  out.push(current);

  return out.map(normalizeSkillName).filter((skill) => skill.length > 0);
}

/**
 * The stored form of one skill: list marker gone, whitespace collapsed,
 * trailing punctuation gone. Case is PRESERVED — somebody who writes "React"
 * should see "React" — while uniqueness is decided case-insensitively by
 * `skillKey`.
 */
export function normalizeSkillName(value: string): string {
  return value
    .replace(LIST_MARKER, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(TRAILING_PUNCTUATION, '')
    .trim();
}

/**
 * The key duplicates are decided on.
 *
 * Turkish-aware: "Yazılım" and "yazilim" are the same skill, and `ı` carries no
 * combining mark, so NFD-stripping alone would leave it as its own entry (the
 * bug fixed once already for requisition skills — `normalizeSkills` in
 * `requisitions.ts`, which now splits through this module).
 */
export function skillKey(value: string): string {
  return normalizeSkillName(value)
    .toLocaleLowerCase('tr')
    .replace(/ı/g, 'i')
    .replace(/ş/g, 's')
    .replace(/ğ/g, 'g')
    .normalize('NFD')
    // Combining-marks range rather than \p{M}: `target` is ES2017, where a
    // Unicode property escape is a compile error (same trick as transliterate.ts).
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * A requisition's required-skills list is the same kind of thing with wider
 * bounds: a job description names more, and longer, requirements than a
 * profile does. The numbers live here (and are re-exported through
 * `REQUISITION_LIMITS`) so the client-side editor can read them without
 * importing `requisitions.ts`, which pulls in Prisma.
 */
export const REQUISITION_SKILL_LIMITS = {
  maxSkills: 50,
  maxSkillLength: 100,
} as const;

export type SkillIssueCode = 'split' | 'duplicate' | 'too_long' | 'too_many';

export interface SkillIssue {
  code: SkillIssueCode;
  /** How many skills the issue is about (pieces, duplicates, offenders, excess). */
  count: number;
  /** One offending or resulting value, for a message the user can act on. */
  sample?: string;
}

export interface SkillParse {
  /**
   * The normalized list. Deduped and emptied of blanks, but NOT truncated and
   * NOT capped — a caller that must not fail (a merge, an import) runs it
   * through `capSkills`, and a caller with a user in front of it refuses and
   * says why. Silently storing half a sentence is the one option nobody wants.
   */
  skills: string[];
  issues: SkillIssue[];
}

export interface SkillLimits {
  maxSkills: number;
  maxSkillLength: number;
}

/**
 * Turn whatever a form or an API payload offers into a skill list, and report
 * everything worth telling the user about it. Never throws.
 *
 * An array element is itself re-split: `["React, Node"]` is one field value a
 * client failed to split, not one skill.
 */
export function parseSkills(
  input: string | readonly string[] | null | undefined,
  limits: SkillLimits = SKILL_LIMITS,
): SkillParse {
  const rawValues = input == null ? [] : typeof input === 'string' ? [input] : input;

  const skills: string[] = [];
  const seen = new Set<string>();
  let pieces = 0;
  let duplicates = 0;

  for (const value of rawValues) {
    if (typeof value !== 'string') continue;
    const parts = splitSkillInput(value);
    pieces += parts.length;
    for (const part of parts) {
      const key = skillKey(part);
      if (seen.has(key)) {
        duplicates++;
        continue;
      }
      seen.add(key);
      skills.push(part);
    }
  }

  const issues: SkillIssue[] = [];
  // "This one field became N skills" — the notice that makes the split visible
  // rather than surprising. Only interesting when a single value was handed in
  // (a paste, a form field); an array of N values arriving as N skills is not
  // news.
  if (rawValues.length === 1 && pieces > 1) {
    issues.push({ code: 'split', count: pieces });
  }
  if (duplicates > 0) issues.push({ code: 'duplicate', count: duplicates });

  const tooLong = skills.filter((skill) => skill.length > limits.maxSkillLength);
  if (tooLong.length > 0) {
    issues.push({ code: 'too_long', count: tooLong.length, sample: tooLong[0] });
  }
  if (skills.length > limits.maxSkills) {
    issues.push({
      code: 'too_many',
      count: skills.length - limits.maxSkills,
      sample: String(skills.length),
    });
  }

  return { skills, issues };
}

/**
 * The issue a write must be refused over, or null. `split` and `duplicate` are
 * things we fixed for the user; these two are things only the user can fix.
 */
export function blockingSkillIssue(issues: readonly SkillIssue[]): SkillIssue | null {
  return issues.find((issue) => issue.code === 'too_long' || issue.code === 'too_many') ?? null;
}

/**
 * The 400 body for a refused write, so the five routes that enforce this say
 * the same thing. `code` is what a client branches on (`too_long` /
 * `too_many`); `error` is a last-resort English line, never rendered verbatim
 * by our own UI — see `@/lib/apiErrorMessage` for that stance.
 */
export function skillErrorBody(
  issue: SkillIssue,
  limits: SkillLimits = SKILL_LIMITS,
): { error: string; code: SkillIssueCode; limit: number; sample?: string } {
  if (issue.code === 'too_many') {
    return {
      error: `At most ${limits.maxSkills} skills`,
      code: issue.code,
      limit: limits.maxSkills,
      sample: issue.sample,
    };
  }
  return {
    error: `A skill can be at most ${limits.maxSkillLength} characters`,
    code: issue.code,
    limit: limits.maxSkillLength,
    sample: issue.sample,
  };
}

/**
 * The lossy variant, for paths where refusing would be worse than shortening:
 * a duplicate merge that must not fail on a union of two long lists, a CV/AI
 * extraction, a CSV import. Truncates on a word boundary where there is one so
 * the result still reads like a skill.
 */
export function capSkills(
  values: string | readonly string[] | null | undefined,
  limits: SkillLimits = SKILL_LIMITS,
): string[] {
  const { skills } = parseSkills(values, limits);
  const capped: string[] = [];
  const seen = new Set<string>();

  for (const skill of skills) {
    if (capped.length >= limits.maxSkills) break;
    const short = truncateSkill(skill, limits.maxSkillLength);
    const key = skillKey(short);
    // Truncation can collide two entries that differed only past the cut.
    if (!short || seen.has(key)) continue;
    seen.add(key);
    capped.push(short);
  }

  return capped;
}

function truncateSkill(skill: string, max: number): string {
  if (skill.length <= max) return skill;
  const cut = skill.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  // Only prefer the word boundary when it keeps most of the budget; otherwise a
  // long first word would shrink the label to nothing.
  const kept = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return normalizeSkillName(kept);
}

/**
 * The label a dense list view shows. A display-side net only: the data is fixed
 * by the rules above and by `prisma/split-oversized-skills.mjs`, but rows
 * written before either existed are still out there, and no card should be
 * destroyed by one of them again.
 */
export function clipSkillLabel(skill: string, max: number = SKILL_LIMITS.labelClip): string {
  const name = normalizeSkillName(skill);
  if (name.length <= max) return name;
  return `${truncateSkill(name, max - 1)}…`;
}
