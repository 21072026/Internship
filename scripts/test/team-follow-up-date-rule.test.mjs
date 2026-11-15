// A colleague's follow-up DAY on the sales calendar's Team view (#3778):
// allowed only when every one of the three facts holds — never the note, which
// canSeeNextAction keeps gating (and which the loader never selects).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { canSeeTeamFollowUpDate } = await import('../../src/lib/teamFollowUpDateRule.ts');
const { canSeeNextAction } = await import('../../src/lib/nextActionRule.ts');

const all = { teamReadAllowed: true, viewerHasSalesSurface: true, sameOrg: true };

test('a team reader on the sales surface sees a colleague’s follow-up day in their own org', () => {
  assert.equal(canSeeTeamFollowUpDate(all), true);
});

test('each missing fact refuses it', () => {
  assert.equal(canSeeTeamFollowUpDate({ ...all, teamReadAllowed: false }), false, 'team book switched off for reps');
  assert.equal(canSeeTeamFollowUpDate({ ...all, viewerHasSalesSurface: false }), false, 'not a sales-surface viewer (INTERNSHIP)');
  assert.equal(canSeeTeamFollowUpDate({ ...all, sameOrg: false }), false, 'another org');
  assert.equal(canSeeTeamFollowUpDate({ teamReadAllowed: false, viewerHasSalesSurface: false, sameOrg: false }), false);
});

test('canSeeNextAction is untouched: a colleague rep still may not read the next-action columns', () => {
  assert.equal(canSeeNextAction({ id: 'rep-a', role: 'MENTOR' }, { mentorId: 'rep-b' }), false);
  assert.equal(canSeeNextAction({ id: 'rep-b', role: 'MENTOR' }, { mentorId: 'rep-b' }), true);
  assert.equal(canSeeNextAction({ id: 'admin', role: 'ADMIN' }, { mentorId: 'rep-b' }), true);
});
