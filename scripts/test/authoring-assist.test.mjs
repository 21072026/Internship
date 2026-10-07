// Authoring assist and enrichment (#2055): the input is text a person pasted —
// never a URL. Statically, none of these modules fetches anything or reaches the
// outbound-HTTP helpers, and none of them writes a row: proposals only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const FILES = [
  'src/lib/ai/translate.ts',
  'src/lib/ai/authoringAssist.ts',
  'src/app/api/admin/ai/translate/route.ts',
  'src/app/api/admin/ai/draft/route.ts',
  'src/app/api/admin/ai/company-enrich/route.ts',
  'src/app/api/profile/enrich/route.ts',
];

test('no URL is fetched and no external profile is scraped', () => {
  for (const f of FILES) {
    const src = read(f);
    assert.doesNotMatch(src, /\bfetch\s*\(|assertPublicHttpsUrl|from ['"]@\/lib\/webhooks['"]|https?:\/\//, `${f} must work on pasted text only`);
  }
});

test('the assist routes return a proposal and write nothing', () => {
  for (const f of FILES.filter((x) => x.includes('/app/api/'))) {
    assert.doesNotMatch(read(f), /prisma\.\w+\.(create|update|upsert|delete|createMany|updateMany|deleteMany)\b/, `${f} must not save anything`);
  }
});
