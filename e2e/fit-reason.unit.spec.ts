import { test, expect } from '@playwright/test';
import { scoreFit } from '@/lib/matching/requisitionFit';
import { anonLabel, buildFitReasonPayload, ruleFitReason, type FitReasonText } from '@/lib/matching/fitReason';

// #2042 — the written fit reason and the AI payload. The payload is the
// compliance boundary: it must never carry a person.

const text: FitReasonText = {
  required: '{n} of {total} required skills: {skills}', requiredNone: '{n} of {total} required skills', nice: 'also {skills}',
  title: 'aims for this kind of role', location: "based in the role's city", remote: 'open to a remote role',
  fallback: 'Listed as an applicant for this role.',
};
const role = { title: 'Frontend Developer', requiredSkillIds: ['react', 'ts', 'css'], niceSkillIds: ['css'], remote: false };
const label = (id: string) => ({ react: 'React', ts: 'TypeScript', css: 'CSS' })[id] ?? id;
const fitOf = (skillIds: string[], extra: Record<string, unknown> = {}) =>
  scoreFit(
    { title: role.title, requiredSkillIds: ['react', 'ts'], niceSkillIds: ['css'], city: 'Berlin' },
    { id: 'u1', targetPosition: 'Frontend Developer', skillIds, city: 'Berlin', stageProgress: 0.5, ...extra },
  );

test('the rule-based sentence says what matched, in words, without a number score', { tag: '@smoke' }, async () => {
  const sentence = ruleFitReason(fitOf(['react', 'css']), role, label, text);
  expect(sentence).toBe("1 of 2 required skills: React; also CSS; aims for this kind of role; based in the role's city.");
  expect(sentence).not.toMatch(/\/100|%|score/i);
  // Nothing applicable at all → the neutral fallback, never an empty string.
  const bare = scoreFit({ title: '', requiredSkillIds: [] }, { id: 'x', targetPosition: null, skillIds: [] });
  expect(ruleFitReason(bare, { ...role, requiredSkillIds: [], niceSkillIds: [] }, label, text)).toBe(text.fallback);
});

test('the AI payload is anonymous by construction — no id, name, e-mail, photo or protected characteristic', { tag: '@smoke' }, async () => {
  const leaky = { fullName: 'Jane Roe', email: 'jane@example.test', id: 'user_123', gender: 'F', birthDate: '1999-01-01', nationality: 'X', photoUrl: 'p.png' };
  const fit = fitOf(['react', 'ts'], leaky);
  const payload = buildFitReasonPayload(role, [fit, fitOf(['ts'])], label);
  const json = JSON.stringify(payload);
  for (const value of ['Jane', 'jane@', 'user_123', '1999', 'p.png', 'u1']) expect(json).not.toContain(value);
  expect(Object.keys(payload)).toEqual(['role', 'candidates']);
  expect(payload.candidates.map((c) => c.label)).toEqual(['A', 'B']);
  for (const c of payload.candidates) {
    expect(Object.keys(c).sort()).toEqual(['label', 'locationFits', 'niceMatched', 'requiredMatched', 'requiredMissing', 'targetsRole']);
  }
  // No score, no stage: the company-facing explanation carries neither.
  expect(json).not.toMatch(/score|stage|contribution|weight/i);
  expect(payload.candidates[0]).toMatchObject({ requiredMatched: ['React', 'TypeScript'], requiredMissing: [] });
});

test('labels are positions: A…Z, then AA', { tag: '@smoke' }, async () => {
  expect([anonLabel(0), anonLabel(25), anonLabel(26), anonLabel(27)]).toEqual(['A', 'Z', 'AA', 'AB']);
});
