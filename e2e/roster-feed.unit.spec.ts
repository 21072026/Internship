import { test, expect } from '@playwright/test';
import {
  ROSTER_FEED_SECRET_PURPOSE,
  cronMatches,
  isValidCron,
  nextCronRun,
  resolveColumns,
  validateFeedConfig,
} from '@/lib/rosterFeed';
import { open, seal } from '@/lib/secretBox';

// The roster feed's configuration rules (#1964), without a database or a
// browser. Three things are pinned here because each one is wrong in a way
// that type-checks:
//   1. the validator refuses what would make a feed silently useless or unsafe
//      — a schedule that never parses, an SFTP feed with no pinned host key,
//      a column map with no e-mail;
//   2. the schedule parser and the "next run" a console shows agree, in UTC;
//   3. the feed's secret round-trips through its own seal purpose and through
//      no other.

const httpsFeed = {
  name: 'HR export',
  transport: 'HTTPS',
  url: 'https://hr.example/roster.csv',
  columnMap: { email: 'WorkEmail', fullName: 'DisplayName' },
};

const codes = (raw: unknown) => {
  const r = validateFeedConfig(raw);
  return r.ok ? [] : r.errors.map((e) => `${e.field}:${e.code}`);
};

test.describe('validateFeedConfig', { tag: '@smoke' }, () => {
  test('accepts a minimal HTTPS feed and normalises it', () => {
    const r = validateFeedConfig({ ...httpsFeed, cronExpression: ' 0  3 * * * ', sftpHost: 'ignored.example' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cronExpression).toBe('0 3 * * *');
    expect(r.value.keyField).toBe('EMAIL');
    expect(r.value.enabled).toBe(false);
    // The other transport's fields are not carried along.
    expect(r.value.sftpHost).toBeNull();
  });

  test('rejects an invalid cron expression', () => {
    for (const cron of ['every night', '* * * *', '60 * * * *', '0 24 * * *', '0 0 0 * *', '*/0 * * * *', '5-1 * * * *']) {
      expect(codes({ ...httpsFeed, cronExpression: cron }), cron).toEqual(['cronExpression:invalid_cron']);
    }
  });

  test('rejects a transport missing its own fields', () => {
    expect(codes({ ...httpsFeed, url: '' })).toEqual(['url:required']);
    expect(codes({ ...httpsFeed, url: 'http://hr.example/roster.csv' })).toEqual(['url:not_https']);
    expect(codes({ ...httpsFeed, url: 'https://user:pw@hr.example/x' })).toEqual(['url:invalid']);
    expect(codes({ ...httpsFeed, transport: 'SFTP' }).sort()).toEqual(
      ['sftpHost:required', 'sftpHostKeyFingerprint:required', 'sftpPath:required', 'sftpUsername:required'].sort(),
    );
    expect(codes({ ...httpsFeed, transport: 'FTP' })).toEqual(['transport:invalid']);
  });

  test('an SFTP feed needs a pinned host key it can parse', () => {
    const sftp = {
      ...httpsFeed,
      transport: 'SFTP',
      sftpHost: 'sftp.hr.example',
      sftpUsername: 'roster',
      sftpPath: '/out/roster.csv',
    };
    expect(codes({ ...sftp, sftpHostKeyFingerprint: 'trust me' })).toEqual(['sftpHostKeyFingerprint:invalid']);
    const ok = validateFeedConfig({
      ...sftp,
      sftpPort: '2222',
      sftpHostKeyFingerprint: 'SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8',
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.sftpPort).toBe(2222);
    expect(codes({ ...sftp, sftpHostKeyFingerprint: 'SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8', sftpPort: 70000 })).toEqual([
      'sftpPort:invalid',
    ]);
    expect(codes({ ...sftp, sftpHost: 'sftp://evil.example/x', sftpHostKeyFingerprint: 'SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8' })).toEqual([
      'sftpHost:invalid',
    ]);
  });

  test('rejects a column map with no email mapping, or no key for an EXTERNAL_ID feed', () => {
    expect(codes({ ...httpsFeed, columnMap: { fullName: 'Name' } })).toEqual(['columnMap.email:missing_email_column']);
    expect(codes({ ...httpsFeed, columnMap: undefined })).toEqual(['columnMap:missing_email_column']);
    expect(codes({ ...httpsFeed, keyField: 'EXTERNAL_ID' })).toEqual(['columnMap.externalId:missing_key_column']);
    expect(codes({ ...httpsFeed, columnMap: { email: 'Mail', salary: 'Pay' } })).toEqual(['columnMap.salary:unknown_field']);
  });

  test('refuses a credential env var name that is not one, and a delimiter we do not parse', () => {
    expect(codes({ ...httpsFeed, credentialEnvVar: 'my secret' })).toEqual(['credentialEnvVar:invalid']);
    expect(codes({ ...httpsFeed, credentialEnvVar: 'ROSTER_FEED_TOKEN', delimiter: ';' })).toEqual([]);
    expect(codes({ ...httpsFeed, delimiter: '#' })).toEqual(['delimiter:invalid']);
    expect(codes({ ...httpsFeed, chunkSize: 5 })).toEqual(['chunkSize:invalid']);
  });
});

test.describe('the schedule', () => {
  test('cronMatches reads the expression in UTC with classic day-field semantics', () => {
    const at = new Date('2026-10-20T03:00:00Z'); // a Tuesday
    expect(cronMatches('0 3 * * *', at)).toBe(true);
    expect(cronMatches('0 3 * * 1', at)).toBe(false);
    expect(cronMatches('0 3 * * 2', at)).toBe(true);
    expect(cronMatches('*/15 3 * * *', new Date('2026-10-20T03:45:30Z'))).toBe(true);
    // Both day fields restricted: either one is enough (Vixie cron).
    expect(cronMatches('0 3 1 * 2', at)).toBe(true);
    expect(cronMatches('0 3 20 * 0', at)).toBe(true);
    expect(cronMatches('0 3 21 * 0', at)).toBe(false);
    // 7 is Sunday too.
    expect(cronMatches('0 0 * * 7', new Date('2026-10-18T00:00:00Z'))).toBe(true);
    expect(isValidCron('0 3,15 1-15/2 */3 1-5')).toBe(true);
  });

  test('nextCronRun is strictly after `from` and agrees with cronMatches', () => {
    const from = new Date('2026-10-20T03:00:00Z');
    expect(nextCronRun('0 3 * * *', from)?.toISOString()).toBe('2026-10-21T03:00:00.000Z');
    expect(nextCronRun('*/5 * * * *', new Date('2026-10-20T03:02:59Z'))?.toISOString()).toBe('2026-10-20T03:05:00.000Z');
    expect(nextCronRun('30 2 * * 1', from)?.toISOString()).toBe('2026-10-26T02:30:00.000Z');
    const leap = nextCronRun('0 0 29 2 *', from);
    expect(leap?.toISOString()).toBe('2028-02-29T00:00:00.000Z');
    expect(cronMatches('0 0 29 2 *', leap!)).toBe(true);
    expect(nextCronRun('0 0 31 2 *', from)).toBeNull();
    expect(nextCronRun('nonsense', from)).toBeNull();
  });
});

test.describe('resolveColumns', () => {
  test('finds mapped columns the way the engine reads them, and names the missing ones', () => {
    const header = [' WorkEmail ', 'displayname', 'Personnel No'];
    const r = resolveColumns(header, { email: 'workemail', fullName: 'DisplayName', externalId: 'Personnel No', phone: 'Mobile' });
    expect(r.indexes).toEqual({ email: 0, externalId: 2, fullName: 1 });
    expect(r.missing).toEqual(['phone']);
  });
});

test.describe('the sealed secret', { tag: '@smoke' }, () => {
  test('round-trips under its own purpose and opens under no other', () => {
    process.env.NEXTAUTH_SECRET ||= 'unit-test-secret-not-for-production';
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----';
    const sealed = seal(key, ROSTER_FEED_SECRET_PURPOSE);
    expect(sealed).not.toContain('OPENSSH');
    expect(open(sealed, ROSTER_FEED_SECRET_PURPOSE)).toBe(key);
    // A key minted for another purpose (the Google tokens') cannot open it.
    expect(open(sealed, 'google-calendar-token')).toBeNull();
    // Nor can a tampered ciphertext.
    const parts = sealed.split('.');
    parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith('AA') ? 'BB' : 'AA');
    expect(open(parts.join('.'), ROSTER_FEED_SECRET_PURPOSE)).toBeNull();
  });
});
