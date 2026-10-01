// The duplicate scan's blocking is lossless (#1436) — pure node, no browser.
// Playwright resolves the tsconfig @/ paths, which node --test cannot. Run with
// BASE_URL=http://localhost:9 to skip the webServer.
//
// The claim under test: findDuplicatePairs() compares only pairs that share a
// bucket, and that changes NOTHING about the result. So it is checked against
// the all-pairs scan it replaced, on random data built to collide on every
// signal (typos, shared phones in either field, placeholder e-mails, blank and
// punctuation-only universities), across many seeds — and then timed at the
// 5 000-mentee size the issue measured.
import { test, expect } from '@playwright/test';
import {
  DUPLICATE_SCORE_THRESHOLD,
  findDuplicatePairs,
  matchSignals,
  scoreSignals,
} from '@/lib/duplicateDetection';
import type { CandidateRecord, DuplicatePair } from '@/lib/duplicateDetection';

// The scan as it was before #1436, verbatim in shape: every pair, i < j, a
// stable sort by score, then the cap.
function allPairs(users: CandidateRecord[], cap = 200): DuplicatePair[] {
  const pairs: DuplicatePair[] = [];
  for (let i = 0; i < users.length; i++) {
    for (let j = i + 1; j < users.length; j++) {
      const signals = matchSignals(users[i], users[j]);
      const score = scoreSignals(signals);
      if (score >= DUPLICATE_SCORE_THRESHOLD) pairs.push({ a: users[i], b: users[j], signals, score });
    }
  }
  return pairs.sort((x, y) => y.score - x.score).slice(0, cap);
}

// Small deterministic PRNG so a failure names a seed that reproduces it.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Wide enough to look like a real cohort, narrow enough that every signal
// collides often: 30 × 30 names (a quarter with a typo), 24 universities.
const FIRST = ['Ayşe', 'Ahmet', 'Mehmet', 'Zeynep', 'İbrahim', 'Çağla', 'Oğuz', 'Şule', 'Ali', 'Elif',
  'Emre', 'Burak', 'Merve', 'Ece', 'Deniz', 'Kerem', 'Selin', 'Can', 'Büşra', 'Gökhan',
  'Hakan', 'İrem', 'Onur', 'Pınar', 'Serkan', 'Tuğba', 'Umut', 'Volkan', 'Yasemin', 'Özge'];
const LAST = ['Yılmaz', 'Kaya', 'Demir', 'Şahin', 'Çelik', 'Öztürk', 'Aydın', 'Arslan', 'Doğan', 'Kılıç',
  'Aslan', 'Çetin', 'Kara', 'Koç', 'Kurt', 'Özdemir', 'Şimşek', 'Polat', 'Erdoğan', 'Güneş',
  'Aksoy', 'Yıldız', 'Yıldırım', 'Özkan', 'Bulut', 'Keskin', 'Ünal', 'Tekin', 'Acar', 'Uçar'];
const UNIS = ['Boğaziçi Üniversitesi', 'boğaziçi üniversitesi', 'ODTÜ', 'İTÜ', 'Hacettepe', 'Ankara',
  'Ege', 'Dokuz Eylül', 'Marmara', 'Yıldız Teknik', 'Gazi', 'Bilkent', 'Koç', 'Sabancı', 'Özyeğin',
  'Bahçeşehir', 'İstanbul', 'Çukurova', 'Erciyes', 'Atatürk', 'Uludağ', '—', '...', '', null] as (string | null)[];

function typo(name: string, r: () => number): string {
  const i = Math.floor(r() * name.length);
  const op = r();
  if (op < 0.33) return name.slice(0, i) + name.slice(i + 1); // delete
  if (op < 0.66) return name.slice(0, i) + 'x' + name.slice(i); // insert
  return name.slice(0, i) + 'q' + name.slice(i + 1); // substitute
}

function population(n: number, seed: number): CandidateRecord[] {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const phones = Array.from({ length: Math.max(3, Math.floor(n / 6)) }, (_, k) => `0555 ${String(1000000 + k)}`);
  const users: CandidateRecord[] = [];
  for (let k = 0; k < n; k++) {
    let fullName = `${pick(FIRST)} ${pick(LAST)}`;
    if (r() < 0.25) fullName = typo(fullName, r);
    if (r() < 0.03) fullName = '';
    const emailRoll = r();
    const email =
      emailRoll < 0.1
        ? `shared${Math.floor(r() * 5)}@example.com`
        : emailRoll < 0.2
          ? `mentee.x.${k}@import.local`
          : `user${k}@example.com`;
    users.push({
      id: `u${k}`,
      fullName,
      email: r() < 0.5 ? email.toUpperCase() : email,
      phone: r() < 0.4 ? pick(phones) : null,
      whatsapp: r() < 0.2 ? `+90${pick(phones).replace(/\D/g, '').slice(1)}` : null,
      university: pick(UNIS),
      createdAt: new Date(2026, 0, 1 + k),
      isActive: true,
    });
  }
  return users;
}

const ids = (pairs: DuplicatePair[]) => pairs.map((p) => `${p.a.id}|${p.b.id}|${p.score}|${p.signals.join(',')}`);

test('blocking finds exactly the pairs the all-pairs scan finds, in the same order', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const users = population(40 + (seed % 7) * 30, seed);
    const expected = allPairs(users, Number.MAX_SAFE_INTEGER);
    const actual = findDuplicatePairs(users, Number.MAX_SAFE_INTEGER);
    expect(ids(actual), `seed ${seed}`).toEqual(ids(expected));
    // And under the real cap, where tie order decides who is cut off.
    expect(ids(findDuplicatePairs(users, 25)), `seed ${seed} capped`).toEqual(ids(allPairs(users, 25)));
  }
});

test('every door is still found: e-mail, either phone field, exact name, fuzzy name + university', () => {
  const base = { createdAt: new Date(0), isActive: true, phone: null, whatsapp: null, university: null };
  const users: CandidateRecord[] = [
    { ...base, id: 'e1', fullName: 'A One', email: 'SAME@x.com' },
    { ...base, id: 'e2', fullName: 'B Two', email: 'same@x.com' },
    { ...base, id: 'p1', fullName: 'C Three', email: 'c@x.com', phone: '+90 555 123 45 67' },
    { ...base, id: 'p2', fullName: 'D Four', email: 'd@x.com', whatsapp: '05551234567' },
    { ...base, id: 'n1', fullName: 'Çağla Şahin', email: 'n1@x.com' },
    { ...base, id: 'n2', fullName: 'cagla sahin', email: 'n2@x.com' },
    { ...base, id: 'f1', fullName: 'Mehmet Yilmaz', email: 'f1@x.com', university: 'ODTÜ' },
    { ...base, id: 'f2', fullName: 'Mehmed Yilmazz', email: 'f2@x.com', university: 'odtu' },
    // Fuzzy name WITHOUT a shared university is 30: never reported.
    { ...base, id: 'g1', fullName: 'Zeynep Kayalar', email: 'g1@x.com', university: 'İTÜ' },
    { ...base, id: 'g2', fullName: 'Zeynep Kayalr', email: 'g2@x.com', university: 'ODTÜ' },
    // Placeholder addresses carry no identity.
    { ...base, id: 'x1', fullName: 'Q One', email: 'mentee.a.1@import.local' },
    { ...base, id: 'x2', fullName: 'R Two', email: 'mentee.a.1@import.local' },
  ];
  const got = findDuplicatePairs(users).map((p) => [p.a.id, p.b.id].sort().join('|')).sort();
  expect(got).toEqual(['e1|e2', 'f1|f2', 'n1|n2', 'p1|p2']);
  expect(ids(findDuplicatePairs(users))).toEqual(ids(allPairs(users)));
});

test('at scale: identical at 1 500 mentees, and 5 000 blocked in well under a second (timings logged)', () => {
  test.setTimeout(120_000);
  const mid = population(1500, 424242);
  const t0 = performance.now();
  const fastMid = findDuplicatePairs(mid);
  const t1 = performance.now();
  const slowMid = allPairs(mid);
  const t2 = performance.now();
  expect(ids(fastMid)).toEqual(ids(slowMid));

  const big = population(5000, 777);
  const t3 = performance.now();
  findDuplicatePairs(big);
  const t4 = performance.now();
  console.log(
    `[#1436] 1500 mentees: blocked ${Math.round(t1 - t0)} ms vs all-pairs ${Math.round(t2 - t1)} ms; ` +
      `5000 mentees blocked: ${Math.round(t4 - t3)} ms`,
  );
  // The acceptance bar in the issue is the whole request under 1 s. This
  // population is deliberately collision-heavy (80 names, 6 universities).
  expect(t4 - t3).toBeLessThan(1000);
});
