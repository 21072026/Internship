// Unit tests for the duplicate-candidate detector (#841) — pure node, no
// browser/page. Playwright resolves the tsconfig @/ paths, which node --test
// cannot. Run with BASE_URL=http://localhost:9 to skip the webServer.
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

const record = (overrides: Partial<CandidateRecord>): CandidateRecord => ({
  id: 'existing',
  fullName: '',
  email: '',
  phone: null,
  whatsapp: null,
  university: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  isActive: true,
  ...overrides,
});

test.describe('normalizeNameKey', () => {
  test('Turkish variants of the same name all key equal', { tag: '@smoke' }, () => {
    for (const variants of [
      ['İpek', 'Ipek', 'ipek', 'IPEK'],
      ['Şeyma', 'Seyma'],
      ['Göksu', 'Goksu'],
      ['Çağrı', 'Cagri', 'ÇAĞRI'],
    ]) {
      const keys = variants.map((v) => normalizeNameKey(v));
      for (const key of keys) expect(key, variants.join('/')).toBe(keys[0]);
    }
    // The 'İ'.toLowerCase() trap: JS yields "i" + a combining dot (two code
    // points), so transliteration must happen BEFORE lowercasing.
    expect(normalizeNameKey('İPEK')).toBe(normalizeNameKey('ipek'));
  });

  test('collapses punctuation, case and whitespace', () => {
    expect(normalizeNameKey('  Mehmet-Ali   ERŞAHİN ')).toBe('mehmet ali ersahin');
  });
});

test.describe('normalizePhoneKey', () => {
  test('national/international/dashed formats all key to the same 10 digits', { tag: '@smoke' }, () => {
    for (const phone of ['+90 555 123 45 67', '0555 123 4567', '00905551234567', '555-123-4567']) {
      expect(normalizePhoneKey(phone), phone).toBe('5551234567');
    }
  });

  test('too-short garbage keys to the empty string (never matches)', () => {
    expect(normalizePhoneKey('123')).toBe('');
    expect(normalizePhoneKey('')).toBe('');
    expect(normalizePhoneKey(null)).toBe('');
    expect(normalizePhoneKey(undefined)).toBe('');
  });
});

test.describe('normalizeEmailKey', () => {
  test('lowercases and trims', { tag: '@smoke' }, () => {
    expect(normalizeEmailKey('  Ipek.Yilmaz@Example.COM ')).toBe('ipek.yilmaz@example.com');
  });

  test('generated placeholder domains carry no identity and key to empty', { tag: '@smoke' }, () => {
    expect(normalizeEmailKey('mentee.ipek.a1b2@import.local')).toBe('');
    expect(normalizeEmailKey('erased-42@erased.local')).toBe('');
    expect(normalizeEmailKey(null)).toBe('');
    expect(normalizeEmailKey(undefined)).toBe('');
  });
});

test.describe('matchSignals + scoreSignals', () => {
  test('same name + university reaches the threshold', { tag: '@smoke' }, () => {
    const signals = matchSignals(
      { fullName: 'İpek Yılmaz', university: 'Boğaziçi Üniversitesi' },
      record({ fullName: 'Ipek Yilmaz', university: 'Bogazici Universitesi' }),
    );
    expect(signals).toEqual(['name', 'university']);
    expect(scoreSignals(signals)).toBeGreaterThanOrEqual(DUPLICATE_SCORE_THRESHOLD);
  });

  test('fuzzy name (one typo, >=6 chars) + university reaches the threshold', () => {
    const signals = matchSignals(
      { fullName: 'Göksu Demir', university: 'ODTÜ' },
      record({ fullName: 'Goksu Demis', university: 'Odtü' }),
    );
    expect(signals).toEqual(['nameFuzzy', 'university']);
    expect(scoreSignals(signals)).toBeGreaterThanOrEqual(DUPLICATE_SCORE_THRESHOLD);
  });

  test('a lone university match yields no signals at all', () => {
    const signals = matchSignals(
      { fullName: 'Şeyma Kaya', university: 'Boğaziçi Üniversitesi' },
      record({ fullName: 'Mehmet Öztürk', university: 'Bogazici Universitesi' }),
    );
    expect(signals).toEqual([]);
    expect(scoreSignals(signals)).toBeLessThan(DUPLICATE_SCORE_THRESHOLD);
  });

  test('a lone fuzzy name does not reach the threshold', () => {
    // Long enough to fire the fuzzy signal, but 30 < 45 on its own.
    const signals = matchSignals(
      { fullName: 'Göksu Demir' },
      record({ fullName: 'Goksu Demis' }),
    );
    expect(signals).toEqual(['nameFuzzy']);
    expect(scoreSignals(signals)).toBeLessThan(DUPLICATE_SCORE_THRESHOLD);

    // Short names (<6 chars normalized) never even fire the fuzzy signal.
    expect(matchSignals({ fullName: 'Ali' }, record({ fullName: 'Alp' }))).toEqual([]);
  });

  test('a phone match alone passes the threshold', { tag: '@smoke' }, () => {
    const signals = matchSignals(
      { fullName: 'Şeyma Kaya', phone: '+90 555 123 45 67' },
      record({ fullName: 'Mehmet Öztürk', phone: '0555 123 4567' }),
    );
    expect(signals).toEqual(['phone']);
    expect(scoreSignals(signals)).toBeGreaterThanOrEqual(DUPLICATE_SCORE_THRESHOLD);
  });

  test('phone matches across the phone/whatsapp fields too', () => {
    const signals = matchSignals(
      { fullName: 'Şeyma Kaya', whatsapp: '555-123-4567' },
      record({ fullName: 'Mehmet Öztürk', phone: '00905551234567' }),
    );
    expect(signals).toEqual(['phone']);
  });
});

test.describe('levenshtein', () => {
  test('exact match is 0, one edit is 1', { tag: '@smoke' }, () => {
    expect(levenshtein('ipek yilmaz', 'ipek yilmaz')).toBe(0);
    expect(levenshtein('ipek yilmaz', 'ipek yilmas')).toBe(1); // substitution
    expect(levenshtein('ipek yilmaz', 'ipek ylmaz')).toBe(1); // deletion
    expect(levenshtein('ipek yilmaz', 'ipekk yilmaz')).toBe(1); // insertion
  });

  test('bails out at max, returning max + 1', () => {
    expect(levenshtein('abcdef', 'uvwxyz', 2)).toBe(3);
    // Length difference alone exceeding max short-circuits the same way.
    expect(levenshtein('a', 'abcdef', 2)).toBe(3);
    expect(levenshtein('abcd', 'wxyz', 1)).toBe(2);
  });
});
