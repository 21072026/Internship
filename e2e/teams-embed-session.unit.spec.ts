import { test, expect } from '@playwright/test';
import { embedSetCookie, injectedCookieHeader, isEmbedSessionEnabled, rewriteSessionSetCookies } from '@/lib/embedSession';
import { issuerMatchesTenant, teamsSsoAudiences } from '@/lib/chat/teamsSsoToken';

// The Teams tab session (#1954), pure rules — no browser, no database.

const ON = { CHAT_APPS_ENABLED: '1', TEAMS_SSO_CLIENT_ID: 'client' };
const TID = '11111111-2222-3333-4444-555555555555';

test.describe('teams embed session', { tag: '@smoke' }, () => {
  test('off unless both switches are set — then every helper is a no-op', () => {
    expect(isEmbedSessionEnabled({})).toBe(false);
    expect(isEmbedSessionEnabled({ CHAT_APPS_ENABLED: '1' })).toBe(false);
    expect(isEmbedSessionEnabled({ TEAMS_SSO_CLIENT_ID: 'client' })).toBe(false);
    expect(isEmbedSessionEnabled(ON)).toBe(true);
    expect(injectedCookieHeader('embed-session=abc', false, {})).toBeNull();
  });

  test('the embed cookie is its own name, Partitioned, SameSite=None, eight hours', () => {
    expect(embedSetCookie('v', true)).toBe('__Secure-embed-session=v; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=28800');
    expect(embedSetCookie('v', false)).toMatch(/^embed-session=v;/);
  });

  test('a real session always wins; an embed cookie alone is handed over as the session', () => {
    expect(injectedCookieHeader('embed-session=abc', false, ON)).toBe('embed-session=abc; next-auth.session-token=abc');
    expect(injectedCookieHeader('next-auth.session-token=real; embed-session=abc', false, ON)).toBeNull();
    expect(injectedCookieHeader('other=1', false, ON)).toBeNull();
  });

  test('a session Set-Cookie on an embed request becomes the embed cookie; others pass', () => {
    const out = rewriteSessionSetCookies(
      ['next-auth.session-token=jwt; Path=/; HttpOnly; SameSite=Lax', 'next-auth.csrf-token=x; Path=/', 'next-auth.session-token=; Max-Age=0; Path=/'],
      false,
    );
    expect(out[0]).toMatch(/^embed-session=jwt; .*SameSite=None; Partitioned; Max-Age=28800$/);
    expect(out[1]).toBe('next-auth.csrf-token=x; Path=/');
    expect(out[2]).toMatch(/^embed-session=; .*Max-Age=0$/);
    expect(out.join('\n')).not.toContain('next-auth.session-token');
  });

  test('the issuer must name the token’s own tenant; audiences are this app only', () => {
    expect(issuerMatchesTenant(`https://login.microsoftonline.com/${TID}/v2.0`, TID)).toBe(true);
    expect(issuerMatchesTenant(`https://sts.windows.net/${TID}/`, TID)).toBe(true);
    expect(issuerMatchesTenant('https://login.microsoftonline.com/99999999-2222-3333-4444-555555555555/v2.0', TID)).toBe(false);
    expect(issuerMatchesTenant('https://evil.example/v2.0', TID)).toBe(false);
    expect(teamsSsoAudiences('client', 'app.example.test')).toEqual(['client', 'api://app.example.test/client']);
  });
});
