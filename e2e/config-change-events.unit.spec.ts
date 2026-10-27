// Configuration events with a redacted before/after diff (#1699) — pure node,
// no browser, no database. Run with BASE_URL=http://localhost:9.
//
// Pins the one diff implementation (src/lib/events/diff.ts): the explicit,
// fail-closed field policy, the fingerprint of a redacted field, and that no
// secret survives into an event payload or the AuditLog row the config-audit
// subscriber writes from it.
import { test, expect } from '@playwright/test';
import {
  API_KEY_DIFF_SPEC,
  ORGANIZATION_DIFF_SPEC,
  RECORDED_VALUE_MAX,
  REDACTED,
  WEBHOOK_DIFF_SPEC,
  fingerprint,
  isSecretShaped,
  policyFor,
  redactedDiff,
} from '@/lib/events/diff';
import { validateEventPayload } from '@/lib/events/catalog';
import { auditRowFor, CONFIG_AUDIT_EVENTS, createConfigAuditSubscriber, type AuditStore } from '@/lib/events/subscribers/configAudit';
import type { DeliveredEvent } from '@/lib/events/subscribers';

const CERT_A = '-----BEGIN CERTIFICATE-----\nMIIBAAAAcertificateA\n-----END CERTIFICATE-----';
const CERT_B = '-----BEGIN CERTIFICATE-----\nMIIBBBBBcertificateB\n-----END CERTIFICATE-----';

const orgBefore = {
  id: 'org1',
  plan: 'ENTERPRISE',
  ssoEnabled: false,
  ssoIssuer: 'https://idp.example/old',
  ssoCertificate: CERT_A,
  supportEmail: 'help@acme.example',
  updatedAt: new Date('2026-10-01T00:00:00Z'),
};

test.describe('redactedDiff()', () => {
  test('records a listed field with both values', () => {
    const after = { ...orgBefore, ssoIssuer: 'https://idp.example/new', updatedAt: new Date() };
    expect(redactedDiff(orgBefore, after, ORGANIZATION_DIFF_SPEC)).toEqual([
      { field: 'ssoIssuer', from: 'https://idp.example/old', to: 'https://idp.example/new' },
    ]);
  });

  test('a certificate change is recorded as a change, redacted, with fingerprints that tell a real change from a re-save', () => {
    const changed = redactedDiff(orgBefore, { ...orgBefore, ssoCertificate: CERT_B }, ORGANIZATION_DIFF_SPEC);
    expect(changed).toEqual([
      {
        field: 'ssoCertificate',
        from: REDACTED,
        to: REDACTED,
        redacted: true,
        fromFingerprint: fingerprint(CERT_A),
        toFingerprint: fingerprint(CERT_B),
      },
    ]);
    expect(changed[0].fromFingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(changed[0].fromFingerprint).not.toBe(changed[0].toFingerprint);
    // Re-saved unchanged: no change at all.
    expect(redactedDiff(orgBefore, { ...orgBefore }, ORGANIZATION_DIFF_SPEC)).toEqual([]);
    // Cleared: the fact it was removed is not a secret.
    expect(redactedDiff(orgBefore, { ...orgBefore, ssoCertificate: null }, ORGANIZATION_DIFF_SPEC)[0]).toMatchObject({
      from: REDACTED,
      to: null,
      toFingerprint: null,
    });
  });

  test('a field the spec does not list is redacted, not recorded (fails closed)', () => {
    const changes = redactedDiff({ brandNewColumn: 'a' }, { brandNewColumn: 'b' }, ORGANIZATION_DIFF_SPEC);
    expect(changes).toEqual([
      expect.objectContaining({ field: 'brandNewColumn', from: REDACTED, to: REDACTED, redacted: true }),
    ]);
    expect(policyFor('brandNewColumn', {})).toBe('redact');
  });

  test('a secret-shaped name is redacted even when a spec says record', () => {
    for (const f of ['secret', 'webhookSecret', 'ssoCertificate', 'hashedKey', 'adminPassword', 'refreshToken', 'privateKey', 'apiKey']) {
      expect(isSecretShaped(f), f).toBe(true);
      expect(policyFor(f, { [f]: 'record' }), f).toBe('redact');
    }
    // A policy ABOUT passwords is not a password.
    for (const f of ['passwordMinLength', 'breachedPasswordCheck', 'passwordRequireUpper', 'tokenTtlDays']) {
      expect(isSecretShaped(f), f).toBe(false);
    }
  });

  test('ignored fields, arrays, dates and long values', () => {
    expect(redactedDiff({ updatedAt: 1 }, { updatedAt: 2 }, ORGANIZATION_DIFF_SPEC)).toEqual([]);
    expect(redactedDiff({ events: ['a', 'b'] }, { events: ['a', 'b'] }, WEBHOOK_DIFF_SPEC)).toEqual([]);
    expect(redactedDiff({ events: ['a'] }, { events: ['a', 'b'] }, WEBHOOK_DIFF_SPEC)).toEqual([
      { field: 'events', from: '["a"]', to: '["a","b"]' },
    ]);
    expect(redactedDiff(null, { expiresAt: new Date('2027-01-01T00:00:00Z') }, API_KEY_DIFF_SPEC)).toEqual([
      { field: 'expiresAt', from: null, to: '2027-01-01T00:00:00.000Z' },
    ]);
    const logo = `data:image/png;base64,${'A'.repeat(5000)}`;
    const [c] = redactedDiff({ brandLogoUrl: null }, { brandLogoUrl: logo }, ORGANIZATION_DIFF_SPEC);
    expect(String(c.to).length).toBe(RECORDED_VALUE_MAX + 1);
  });

  test('the webhook URL (a chat hook carries its token in the path) and support e-mail are fingerprinted', () => {
    const [url] = redactedDiff(null, { url: 'https://hooks.example/services/T00/B00/s3cr3tpath' }, WEBHOOK_DIFF_SPEC);
    expect(url).toMatchObject({ field: 'url', from: null, to: REDACTED, redacted: true });
    const [mail] = redactedDiff(orgBefore, { ...orgBefore, supportEmail: 'other@acme.example' }, ORGANIZATION_DIFF_SPEC);
    expect(mail).toMatchObject({ field: 'supportEmail', redacted: true });
  });
});

test.describe('config events and the AuditLog subscriber', () => {
  const secrets = [CERT_A, CERT_B, 'help@acme.example', 's3cr3tpath', 'hashed-api-key-value', 'whsec_live_value'];

  function event(name: string, payload: Record<string, unknown>, orgId: string | null = 'org1'): DeliveredEvent {
    return {
      id: 'evt_1',
      name,
      version: 1,
      payload,
      orgId,
      actorId: 'admin1',
      actorType: 'user',
      subjectType: null,
      subjectId: (payload.orgId ?? payload.webhookId ?? payload.apiKeyId ?? payload.key ?? null) as string | null,
      correlationId: null,
      createdAt: '2026-10-27T10:00:00.000Z',
    };
  }

  test('no secret, hashed key or address appears in a payload or in AuditLog.detail', { tag: '@smoke' }, () => {
    const orgChanges = redactedDiff(
      orgBefore,
      { ...orgBefore, ssoIssuer: 'https://idp.example/new', ssoCertificate: CERT_B, supportEmail: 'x@acme.example' },
      ORGANIZATION_DIFF_SPEC,
    );
    const hookChanges = redactedDiff(
      null,
      { url: 'https://hooks.example/s3cr3tpath', events: ['pipeline.stage_change'], active: true, secret: 'whsec_live_value' },
      WEBHOOK_DIFF_SPEC,
    );
    const keyChanges = redactedDiff(null, { name: 'CI', scopes: 'candidates:read', hashedKey: 'hashed-api-key-value' }, API_KEY_DIFF_SPEC);
    const payloads: [string, Record<string, unknown>][] = [
      ['org.config.changed', { orgId: 'org1', changes: orgChanges }],
      ['webhook.registered', { webhookId: 'w1', events: ['pipeline.stage_change'], changes: hookChanges }],
      ['apikey.created', { apiKeyId: 'k1', changes: keyChanges }],
    ];
    for (const [name, payload] of payloads) {
      const check = validateEventPayload(name, payload);
      expect(check.ok, name).toBe(true);
      const detail = auditRowFor(event(name, payload)).detail;
      for (const secret of secrets) {
        expect(JSON.stringify(payload).includes(secret), `${name} payload leaks`).toBe(false);
        expect(detail.includes(secret), `${name} detail leaks`).toBe(false);
      }
    }
    // The issuer change itself is there, with both values.
    expect(JSON.stringify(orgChanges)).toContain('https://idp.example/new');
  });

  test('every config event is in the catalogue as an internal event', () => {
    for (const name of CONFIG_AUDIT_EVENTS) {
      expect(validateEventPayload(name, {}).ok, name).toBe(false); // known name, wrong payload
      expect(validateEventPayload(name, {}).ok === false && (validateEventPayload(name, {}) as { reason: string }).reason, name).toBe(
        'invalid_payload',
      );
    }
  });

  test('the subscriber writes one row per event, stamped with the tenant and the actor, and a rerun writes nothing', async () => {
    const rows: ReturnType<typeof auditRowFor>[] = [];
    const store: AuditStore = {
      exists: async ({ action, targetId, eventId }) =>
        rows.some((r) => r.action === action && r.targetId === targetId && r.detail.startsWith(`{"eventId":${JSON.stringify(eventId)}`)),
      create: async (row) => rows.push(row),
    };
    const sub = createConfigAuditSubscriber(store);
    const e = event('org.config.changed', {
      orgId: 'org1',
      changes: [{ field: 'ssoIssuer', from: 'a', to: 'b' }],
    });
    await sub.handle(e);
    await sub.handle(e);
    expect(rows).toEqual([
      {
        orgId: 'org1',
        actorId: 'admin1',
        action: 'org.config.changed',
        targetId: 'org1',
        detail: '{"eventId":"evt_1","orgId":"org1","changes":[{"field":"ssoIssuer","from":"a","to":"b"}]}',
      },
    ]);
    // No actor → 'system'; a global event keeps its null tenant.
    expect(auditRowFor({ ...event('setting.changed', { key: 'k' }, null), actorId: null })).toMatchObject({ orgId: null, actorId: 'system' });
  });
});
