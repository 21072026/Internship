// Unit tests for the sandbox key's rules (#1992) — pure node, no browser, no
// database. Run with BASE_URL=http://localhost:9 to skip the webServer.
//
// Proves: a key can be minted only on a demo deployment whose database is a demo
// database (either half alone is not enough), and the key can only read.
import { test, expect } from '@playwright/test';
import { databaseName, sandboxEnabled, SANDBOX_SCOPES } from '@/lib/api/sandboxKeyRule';
import { API_SCOPES } from '@/lib/apiScopes';

test.describe('sandbox key rule', { tag: '@smoke' }, () => {
  test('both halves are required: DEMO_MODE and a _demo database', () => {
    const demoDb = 'mysql://u:p@db:3306/internship_crm_demo';
    expect(sandboxEnabled({ DEMO_MODE: 'true', DATABASE_URL: demoDb })).toBe(true);
    expect(sandboxEnabled({ DEMO_MODE: 'true', DATABASE_URL: `${demoDb}?connection_limit=5` })).toBe(true);
    // A real deployment with the flag set by mistake.
    expect(sandboxEnabled({ DEMO_MODE: 'true', DATABASE_URL: 'mysql://u:p@db:3306/internship_crm' })).toBe(false);
    // A demo database without the flag.
    expect(sandboxEnabled({ DATABASE_URL: demoDb })).toBe(false);
    expect(sandboxEnabled({ DEMO_MODE: '1', DATABASE_URL: demoDb })).toBe(false);
    // Lookalikes do not pass.
    expect(sandboxEnabled({ DEMO_MODE: 'true', DATABASE_URL: 'mysql://u:p@db:3306/internship_demo_copy' })).toBe(false);
    expect(sandboxEnabled({ DEMO_MODE: 'true', DATABASE_URL: 'mysql://u:p@demo_host/real' })).toBe(false);
    expect(sandboxEnabled({ DEMO_MODE: 'true' })).toBe(false);
  });

  test('databaseName reads the path, not the host or the query', () => {
    expect(databaseName('mysql://u:p@h:3306/a_demo?x=1')).toBe('a_demo');
    expect(databaseName('mysql://u:p@h_demo:3306/real')).toBe('real');
    expect(databaseName('')).toBe('');
    expect(databaseName(undefined)).toBe('');
  });

  test('the key reads and never writes', () => {
    expect(SANDBOX_SCOPES.length).toBeGreaterThan(0);
    for (const s of SANDBOX_SCOPES) expect(s.endsWith(':read'), s).toBe(true);
    expect(SANDBOX_SCOPES).not.toContain('interactions:read_notes');
    for (const s of API_SCOPES.filter((x) => /:write$/.test(x))) expect(SANDBOX_SCOPES).not.toContain(s);
  });
});
