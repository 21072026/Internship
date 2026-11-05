import { test, expect } from '@playwright/test';
import { answerableInChat, choicesFor, decodeState, encodeState, isButtonAnswerable } from '../src/lib/chat/surveyFlow';

// Answering a survey in chat (#1953), the pure half: which questions a button
// answers, what it offers, and the answers-so-far a button carries.

const yesNo = { yes: 'Yes', no: 'No' };
const q = (type: string, extra: Record<string, unknown> = {}) => ({ key: 'k', type, required: true, labels: { en: 'Q' }, options: null, ...extra });

test.describe('chat survey flow', { tag: '@smoke' }, () => {
  test('only bounded single answers are button-answerable; one other type sends the whole survey to the page', () => {
    for (const t of ['NPS', 'SCALE', 'BOOLEAN']) expect(isButtonAnswerable(q(t)), t).toBe(true);
    expect(isButtonAnswerable(q('SELECT', { options: [{ value: 'a', labels: { en: 'A' } }] }))).toBe(true);
    for (const t of ['TEXT', 'LONG_TEXT', 'MULTI_SELECT', 'NUMBER', 'DATE', 'SELECT']) expect(isButtonAnswerable(q(t)), t).toBe(false);
    expect(answerableInChat([q('NPS'), q('BOOLEAN')])).toBe(true);
    expect(answerableInChat([q('NPS'), q('LONG_TEXT')])).toBe(false);
    expect(answerableInChat([])).toBe(false);
  });

  test('the buttons are exactly the values the engine validates', () => {
    expect(choicesFor(q('NPS'), 'en', yesNo).map((c) => c.value)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(choicesFor(q('SCALE'), 'en', yesNo).map((c) => c.value)).toEqual([1, 2, 3, 4, 5]);
    expect(choicesFor(q('BOOLEAN'), 'en', yesNo)).toEqual([{ label: 'Yes', value: true }, { label: 'No', value: false }]);
    expect(choicesFor(q('SELECT', { options: [{ value: 'a', labels: { en: 'A', tr: 'Ä' } }] }), 'tr', yesNo)).toEqual([{ label: 'Ä', value: 'a' }]);
  });

  test('the state round-trips, and anything else decodes to nothing', () => {
    const state = { invitationId: 'inv_1', next: 2, answers: { nps: 9, ok: true, pick: 'a' } };
    expect(decodeState(encodeState(state))).toEqual(state);
    expect(encodeState(state).length).toBeLessThan(2000);
    expect(decodeState(null)).toBeNull();
    expect(decodeState(`${encodeState(state)}|x`)).toBeNull();
    expect(decodeState('bad id!|0|e30')).toBeNull();
    expect(decodeState('inv_1|x|e30')).toBeNull();
    const nested = Buffer.from(JSON.stringify({ a: { b: 1 } })).toString('base64url');
    expect(decodeState(`inv_1|0|${nested}`)).toBeNull();
    const list = Buffer.from(JSON.stringify([1])).toString('base64url');
    expect(decodeState(`inv_1|0|${list}`)).toBeNull();
  });
});
