// Unit tests for the duplicate-candidate detector (#841) — pure node, no browser/page.
// Playwright resolves the tsconfig @/ paths, which node --test cannot.
import { test, expect } from '@playwright/test';
import {
  normalizeNameKey,
  normalizePhoneKey,
  normalizeEmailKey,
  levenshtein,
  matchSignals,
  scoreSignals,
  DUPLICATE_SCORE_THRESHOLD,
} from '@/lib/duplicateDetection';
import type { CandidateRecord } from '@/lib/duplicateDetection';

function record(overrides: Partial<CandidateRecord> = {}): CandidateRecord {
  return {
    id: 'u1',
    fullName: 'Ayşe Yılmaz',
    email: 'ayse@example.com',
    phone: null,
    whatsapp: null,
    university: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    isActive: true,
    ...overrides,
  };
}

test.describe('normalizeNameKey (Turkish-safe)', () => {
  test('İpek/Ipek/ipek/IPEK all key equal', { tag: '@smoke' }, () => {
    const key = normalizeNameKey('İpek');
    expect(key).toBeTruthy();
    expect(normalizeNameKey('Ipek')).toBe(key);
    expect(normalizeNameKey('ipek')).toBe(key);
    expect(normalizeNameKey('IPEK')).toBe(key);
  });

  test("the 'İ'.toLowerCase() two-code-point trap does not split keys", { tag: '@smoke' }, () => {
    // 'İ'.toLowerCase() in JS yields "i" + U+0307 (two code points); the
    // normalizer must transliterate BEFORE lowercasing so these stay equal.
    expect(normalizeNameKey('İPEK')).toBe(normalizeNameKey('ipek'));
  });

  test('Şeyma/Seyma, Göksu/Goksu, Çağrı/Cagri/ÇAĞRI key equal', { tag: '@smoke' }, () => {
    expect(normalizeNameKey('Şeyma')).toBe(normalizeNameKey('Seyma'));
    expect(normalizeNameKey('Göksu')).toBe(normalizeNameKey('Goksu'));
    expect(normalizeNameKey('Çağrı')).toBe(normalizeNameKey('Cagri'));
    expect(normalizeNameKey('ÇAĞRI')).toBe(normalizeNameKey('Cagri'));
  });
});

test.describe('normalizePhoneKey', () => {
  test('country-code, trunk-zero and separators all collapse to the last 10 digits', { tag: '@smoke' }, () => {
    expect(normalizePhoneKey('+90 555 123 45 67')).toBe('5551234567');
    expect(normalizePhoneKey('0555 123 4567')).toBe('5551234567');
    expect(normalizePhoneKey('00905551234567')).toBe('5551234567');
    expect(normalizePhoneKey('555-123-4567')).toBe('5551234567');
  });

  test('short garbage never yields a key', () => {
    expect(normalizePhoneKey('123')).toBe('');
    expect(normalizePhoneKey(null)).toBe('');
    expect(normalizePhoneKey(undefined)).toBe('');
  });
});

test.describe('normalizeEmailKey', () => {
  test('case and surrounding whitespace are ignored', { tag: '@smoke' }, () => {
    expect(normalizeEmailKey('  Ayse.Yilmaz@Example.COM ')).toBe('ayse.yilmaz@example.com');
  });

  test('placeholder domains carry no identity and key to empty', { tag: '@smoke' }, () => {
    expect(normalizeEmailKey('mentee.ayse.ab12cd@import.local')).toBe('');
    expect(normalizeEmailKey('erased-123@erased.local')).toBe('');
    expect(normalizeEmailKey(null)).toBe('');
  });
});

test.describe('levenshtein (bounded)', () => {
  test('exact match is 0, one edit is 1', () => {
    expect(levenshtein('ipek yilmaz', 'ipek yilmaz')).toBe(0);
    expect(levenshtein('ipek yilmaz', 'ipek yilmas')).toBe(1);
  });

  test('bails out at max and returns max + 1', () => {
    expect(levenshtein('abcdef', 'zzzzzz', 2)).toBe(3);
    expect(levenshtein('short', 'a much longer string', 2)).toBe(3);
    expect(levenshtein('abc', 'abx', 0)).toBe(1);
  });
});

test.describe('matchSignals + scoreSignals', () => {
  test('same name + same university passes the threshold', { tag: '@smoke' }, () => {
    const other = record({ fullName: 'İpek Yılmaz', university: 'Boğaziçi Üniversitesi' });
    const signals = matchSignals(
      { fullName: 'Ipek Yilmaz', university: 'Bogazici Universitesi' },
      other,
    );
    expect(signals).toEqual(['name', 'university']);
    expect(scoreSignals(signals)).toBeGreaterThanOrEqual(DUPLICATE_SCORE_THRESHOLD);
  });

  test('fuzzy name (1 typo, >= 6 chars) + university passes', { tag: '@smoke' }, () => {
    const other = record({ fullName: 'İpek Yılmaz', university: 'Boğaziçi Üniversitesi' });
    const signals = matchSignals(
      { fullName: 'Ipek Yilmas', university: 'Bogazici Universitesi' },
      other,
    );
    expect(signals).toEqual(['nameFuzzy', 'university']);
    expect(scoreSignals(signals)).toBeGreaterThanOrEqual(DUPLICATE_SCORE_THRESHOLD);
  });

  test('lone university or lone fuzzy name never reaches the threshold', { tag: '@smoke' }, () => {
    // university only counts alongside a name signal, so a name mismatch
    // yields no signals at all even with matching universities.
    const other = record({ fullName: 'Mehmet Demir', university: 'Boğaziçi Üniversitesi' });
    const signals = matchSignals(
      { fullName: 'Ayşe Kaya', university: 'Bogazici Universitesi' },
      other,
    );
    expect(signals).toEqual([]);
    // And the raw scores of the weak signals stay below the bar on their own.
    expect(scoreSignals(['university'])).toBeLessThan(DUPLICATE_SCORE_THRESHOLD);
    expect(scoreSignals(['nameFuzzy'])).toBeLessThan(DUPLICATE_SCORE_THRESHOLD);
  });

  test('phone match alone passes (whatsapp counts as a phone)', { tag: '@smoke' }, () => {
    const other = record({ fullName: 'Mehmet Demir', whatsapp: '0555 123 4567' });
    const signals = matchSignals({ fullName: 'Ayşe Kaya', phone: '+90 555 123 45 67' }, other);
    expect(signals).toEqual(['phone']);
    expect(scoreSignals(signals)).toBeGreaterThanOrEqual(DUPLICATE_SCORE_THRESHOLD);
  });

  test('placeholder emails never produce an email signal', () => {
    const other = record({ email: 'mentee.ayse.ab12cd@import.local', fullName: 'Zeynep Ak' });
    const signals = matchSignals(
      { fullName: 'Elif Su', email: 'mentee.ayse.ab12cd@import.local' },
      other,
    );
    expect(signals).toEqual([]);
  });
});
