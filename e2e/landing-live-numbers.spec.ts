import { test, expect } from '@playwright/test';
import { buildLiveStripPieces } from '@/lib/liveStrip';
import { getDictionary } from '@/i18n/dictionaries';

// #1099: the hero's live status strip. The zero-hiding rule is unit-tested
// (pure helper, no DB needed — the shared local/CI database always has rows,
// so an end-to-end zero-state can't be staged there), and the public stats
// endpoint is asserted to be session-less, integer-only and PII-free.

const en = getDictionary('en');
const templates = {
  mentors: en.landing.liveMentors,
  openProjects: en.landing.liveProjects,
  waitingCandidates: en.landing.liveWaiting,
};

test.describe('buildLiveStripPieces', () => {
  test('a zero count drops its piece; all-zero yields an empty strip', () => {
    // All three at zero → nothing at all (no empty separators, no heading).
    expect(buildLiveStripPieces({ mentors: 0, openProjects: 0, waitingCandidates: 0 }, templates)).toEqual([]);

    // A single zero hides exactly that piece.
    const pieces = buildLiveStripPieces({ mentors: 5, openProjects: 0, waitingCandidates: 2 }, templates);
    expect(pieces).toHaveLength(2);
    expect(pieces[0]).toBe('5 mentors');
    expect(pieces[1]).toBe('2 candidates waiting for a mentor');
    expect(pieces.join(' · ')).not.toContain('0');
  });

  test('every locale interpolates the count into its template', () => {
    for (const locale of ['en', 'tr', 'de'] as const) {
      const L = getDictionary(locale).landing;
      const pieces = buildLiveStripPieces(
        { mentors: 7, openProjects: 3, waitingCandidates: 4 },
        { mentors: L.liveMentors, openProjects: L.liveProjects, waitingCandidates: L.liveWaiting }
      );
      expect(pieces).toHaveLength(3);
      expect(pieces[0]).toContain('7');
      expect(pieces[1]).toContain('3');
      expect(pieces[2]).toContain('4');
      for (const piece of pieces) expect(piece).not.toContain('{n}');
    }
  });
});

test('GET /api/public/stats is session-less, integer-only and PII-free', async ({ request }) => {
  const res = await request.get('/api/public/stats');
  expect(res.status()).toBe(200);
  const body = await res.json();
  // Exactly the three counters — nothing else can ever ride along.
  expect(Object.keys(body).sort()).toEqual(['mentors', 'openProjects', 'waitingCandidates']);
  for (const value of Object.values(body)) {
    expect(Number.isInteger(value)).toBe(true);
    expect(value as number).toBeGreaterThanOrEqual(0);
  }
});
