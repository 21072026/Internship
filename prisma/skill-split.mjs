// The skill-splitting rule, in plain ESM, for the deploy-time scripts (#2314).
//
// WHY A SECOND COPY EXISTS
//   `src/lib/skills.ts` is the source of truth and the app's only reference.
//   The backfill next to this file, however, runs as `node prisma/*.mjs` on the
//   server (Node 20, no type stripping, no `@/` alias, no bundler), so it
//   cannot import the TypeScript module — the same split `src/lib/plans.ts` and
//   the plan backfill live with (#1731).
//
//   A copy that nothing compares is a copy that drifts, so
//   `scripts/test/skills.test.mjs` runs a corpus through BOTH and fails on the
//   first disagreement. Change one, change the other, in the same commit.
//
// Keep this file free of imports: `PrismaClient` belongs in the backfill, not
// in the rule, so the test can load the rule without a database.

export const SKILL_LIMITS = {
  maxSkills: 40,
  maxSkillLength: 60,
};

const SEPARATORS = new Set([',', ';', '\n', '\r', '\t', '•', '·', '|']);
const LIST_MARKER = /^(?:[-*–—•·]+\s*|\d{1,2}[.)]\s+)/;
const TRAILING_PUNCTUATION = /[.,;:·•|\s]+$/;

export function normalizeSkillName(value) {
  return value
    .replace(LIST_MARKER, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(TRAILING_PUNCTUATION, '')
    .trim();
}

export function splitSkillInput(raw) {
  const out = [];
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

export function skillKey(value) {
  return normalizeSkillName(value)
    .toLocaleLowerCase('tr')
    .replace(/ı/g, 'i')
    .replace(/ş/g, 's')
    .replace(/ğ/g, 'g')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function truncateSkill(skill, max) {
  if (skill.length <= max) return skill;
  const cut = skill.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  const kept = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return normalizeSkillName(kept);
}

/** The lossy variant — mirrors `capSkills` in src/lib/skills.ts exactly. */
export function capSkills(values, limits = SKILL_LIMITS) {
  const raw = values == null ? [] : typeof values === 'string' ? [values] : values;
  const capped = [];
  const seen = new Set();

  for (const value of raw) {
    if (typeof value !== 'string') continue;
    for (const candidate of splitSkillInput(value)) {
      if (capped.length >= limits.maxSkills) return capped;
      const short = truncateSkill(candidate, limits.maxSkillLength);
      const key = skillKey(short);
      if (!short || seen.has(key)) continue;
      seen.add(key);
      capped.push(short);
    }
  }

  return capped;
}
