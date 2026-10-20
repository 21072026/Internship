// Write prisma/skill-seed.json from src/lib/skillSeed.ts (#1819).
//
// The deploy-time taxonomy backfill runs on Node 20 inside the image and cannot
// import TypeScript, so it reads the starter vocabulary from this JSON copy.
// scripts/test/skill-taxonomy-mirror.test.mjs fails when the copy is stale.
//
// Run: npm run skills:seed-json
import { writeFileSync } from 'node:fs';
import { SKILL_SEED } from '../src/lib/skillSeed.ts';

const out = new URL('../prisma/skill-seed.json', import.meta.url);
writeFileSync(out, `${JSON.stringify(SKILL_SEED, null, 2)}\n`);
console.log(`wrote ${SKILL_SEED.length} skills to prisma/skill-seed.json`);
