import { test, expect } from '@playwright/test';
import {
  GLOBAL_SETTING_KEYS,
  SETTING_DEFAULTS,
  SETTING_SCHEMA,
  parseSettingValue,
  pickSetting,
  settingAllowsScope,
  settingRowsQuery,
  type SettingKey,
  type SettingRow,
} from '../src/lib/settings';

// The settings chain (#1619) — the rule alone, no browser and no database.
// programme row → org row → global row → code default, written once in
// pickSetting() and read by both the string readers and resolveSetting().

const ORG = 'org-a';
const OTHER = 'org-b';
const PROGRAM = 'cohort-1';

function row(orgId: string | null, programId: string | null, key: SettingKey, value: string): SettingRow {
  return { orgId, programId, key, value };
}

test('every catalogued default parses to its own type', { tag: '@smoke' }, () => {
  expect(parseSettingValue('reminderDays', SETTING_DEFAULTS.reminderDays)).toBe(14);
  expect(parseSettingValue('weeklyDigest', SETTING_DEFAULTS.weeklyDigest)).toBe(true);
  expect(parseSettingValue('blindReview', SETTING_DEFAULTS.blindReview)).toBe(false);
  expect(parseSettingValue('require2fa', SETTING_DEFAULTS.require2fa)).toBe('off');
  expect(parseSettingValue('broadcastMonthlyRecipients', SETTING_DEFAULTS.broadcastMonthlyRecipients)).toBeNull();
  expect(parseSettingValue('supportEmail', SETTING_DEFAULTS.supportEmail)).toBe('');
  // A default that its own type refuses would read as a fabricated value.
  for (const key of Object.keys(SETTING_DEFAULTS) as SettingKey[]) {
    const spec = SETTING_SCHEMA[key];
    const value = parseSettingValue(key, SETTING_DEFAULTS[key]);
    if (spec.type === 'number') {
      if (!('nullable' in spec && spec.nullable)) expect(Number.isInteger(value), key).toBe(true);
    } else if (spec.type === 'boolean') expect(typeof value, key).toBe('boolean');
    else if (spec.type === 'enum') expect(spec.values as readonly unknown[], key).toContain(value);
  }
});

test('a stored value the type refuses reads as the typed default, never NaN', { tag: '@smoke' }, () => {
  expect(parseSettingValue('reminderDays', 'soon')).toBe(14);
  expect(parseSettingValue('reminderDays', ' 21 ')).toBe(21);
  expect(parseSettingValue('weeklyDigest', 'yes')).toBe(true);
  expect(parseSettingValue('require2fa', 'everyone')).toBe('off');
  expect(parseSettingValue('salesMonthlyWonTarget', '6')).toBe(6);
  expect(parseSettingValue('salesMonthlyWonTarget', 'x')).toBeNull();
  expect(parseSettingValue('supportEmail', 'not an address')).toBe('');
  expect(parseSettingValue('supportEmail', ' help@acme.example ')).toBe('help@acme.example');
});

test('programme beats org beats global beats default', { tag: '@smoke' }, () => {
  const scope = { orgId: ORG, programId: PROGRAM };
  let rows = [
    row(ORG, PROGRAM, 'reminderDays', '3'),
    row(ORG, null, 'reminderDays', '7'),
    row(null, null, 'reminderDays', '10'),
  ];
  expect(pickSetting(rows, 'reminderDays', scope)).toEqual({ raw: '3', source: 'program' });
  rows = rows.slice(1);
  expect(pickSetting(rows, 'reminderDays', scope)).toEqual({ raw: '7', source: 'org' });
  rows = rows.slice(1);
  expect(pickSetting(rows, 'reminderDays', scope)).toEqual({ raw: '10', source: 'global' });
  expect(pickSetting([], 'reminderDays', scope)).toEqual({ raw: '14', source: 'default' });
});

test('a layer the key does not allow is never read, and no other tenant leaks in', { tag: '@smoke' }, () => {
  // require2fa binds the whole tenant: a programme row for it is ignored.
  expect(settingAllowsScope('require2fa', 'program')).toBe(false);
  const rows = [row(ORG, PROGRAM, 'require2fa', 'all'), row(ORG, null, 'require2fa', 'admins')];
  expect(pickSetting(rows, 'require2fa', { orgId: ORG, programId: PROGRAM })).toEqual({ raw: 'admins', source: 'org' });

  // A deployment-global key ignores tenant rows altogether.
  expect(GLOBAL_SETTING_KEYS.has('jobRetentionDays')).toBe(true);
  const global = [row(ORG, null, 'jobRetentionDays', '1'), row(null, null, 'jobRetentionDays', '45')];
  expect(pickSetting(global, 'jobRetentionDays', { orgId: ORG, programId: null })).toEqual({ raw: '45', source: 'global' });

  // Another org's rows — and another programme's — are not this scope's layers.
  const foreign = [row(OTHER, null, 'reminderDays', '1'), row(ORG, 'cohort-2', 'reminderDays', '2')];
  expect(pickSetting(foreign, 'reminderDays', { orgId: ORG, programId: PROGRAM }).source).toBe('default');

  // No org bound = the global layer alone, even if a row says otherwise.
  expect(pickSetting([row(ORG, null, 'reminderDays', '7')], 'reminderDays', { orgId: null, programId: null }).source).toBe(
    'default',
  );
});

test('GLOBAL_SETTING_KEYS is exactly the keys with no org scope', { tag: '@smoke' }, () => {
  expect([...GLOBAL_SETTING_KEYS].sort()).toEqual([
    'activityLogRetentionDays',
    'jobRetentionDays',
    'orphanApplicantGraceDays',
    'pageViewRetentionDays',
    'pushSubscriptionStaleDays',
    'viewLogWindowMinutes',
  ]);
  // Every key is catalogued, and every key has the global layer.
  expect(Object.keys(SETTING_SCHEMA).sort()).toEqual(Object.keys(SETTING_DEFAULTS).sort());
  for (const key of Object.keys(SETTING_SCHEMA) as SettingKey[]) expect(settingAllowsScope(key, 'global'), key).toBe(true);
});

test('one scope is one query: every layer it needs, and no other', { tag: '@smoke' }, () => {
  expect(settingRowsQuery({ orgId: ORG, programId: PROGRAM }).where.OR).toEqual([
    { orgId: null, programId: null },
    { orgId: ORG, programId: null },
    { orgId: ORG, programId: PROGRAM },
  ]);
  expect(settingRowsQuery({ orgId: null, programId: null }).where.OR).toEqual([{ orgId: null, programId: null }]);
});

// Compile-time contract: an unknown key is a type error, and values are typed.
// (Never executed — the assertion is that this file type-checks.)
async function typeContract(resolve: typeof import('../src/lib/settingsResolver').resolveSetting) {
  const days: number = await resolve('reminderDays');
  const digest: boolean = await resolve('weeklyDigest');
  const policy: 'off' | 'admins' | 'admins_mentors' | 'all' = await resolve('require2fa');
  // @ts-expect-error — not a setting
  await resolve('reminderDayz');
  return [days, digest, policy];
}
void typeContract;
