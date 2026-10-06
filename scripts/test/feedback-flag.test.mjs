import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./ts-extensionless-resolve.mjs', import.meta.url);

const { negativeThemeRows, flagsByRelation } = await import('../../src/lib/insights/feedbackFlagRule.ts');

const theme = (label, sentiment, ids) => ({ label, sentiment, count: ids.length, exampleIds: ids });

test('only negative themes raise a flag — unclear and neutral never do', () => {
  const rows = negativeThemeRows({ themes: [theme('Tooling', 'negative', ['e1', 'e2']), theme('Mixed', 'unclear', ['e3']), theme('Fine', 'neutral', ['e4']), theme('Docs', 'negative', ['e2'])] });
  assert.deepEqual([...rows], [['e1', ['Tooling']], ['e2', ['Tooling', 'Docs']]]);
});

test('rows fold into one flag per relation; unknown rows are skipped', () => {
  const at1 = new Date('2026-10-01T10:00:00Z');
  const at2 = new Date('2026-10-05T10:00:00Z');
  const flags = flagsByRelation(
    [
      { summary: { themes: [theme('Tooling', 'negative', ['e1', 'e2', 'gone'])] }, at: at1 },
      { summary: { themes: [theme('VPN access', 'negative', ['w1']), theme('Praise', 'positive', ['w2'])] }, at: at2 },
    ],
    new Map([['e1', 'rel-a'], ['e2', 'rel-a'], ['w1', 'rel-a'], ['w2', 'rel-b']]),
  );
  assert.deepEqual([...flags.keys()], ['rel-a']);
  assert.deepEqual(flags.get('rel-a'), { themes: ['Tooling', 'VPN access'], at: at2.toISOString() });
});
