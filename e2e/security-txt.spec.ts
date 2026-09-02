import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ASSURANCE_LINKS } from '@/lib/trustAssurance';

/**
 * `/.well-known/security.txt` and the assurance documents behind it (#2031).
 *
 * Not `@smoke`: nothing in a user's critical path depends on this file, so it
 * belongs in the 4×-daily full suite rather than the PR gate. That placement is
 * also what makes the expiry assertion useful — it is a dated tripwire that
 * fires on a schedule, without a commit, which is exactly how a stale
 * `Expires` field should be discovered.
 */

const REPO_ROOT = process.cwd();
const REPO_BLOB = 'https://github.com/21072026/Internship/blob/main/';

function parseFields(body: string): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    // RFC 9116 § 2.3: '#' starts a comment line.
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    expect(colon, `not a "name: value" line: ${line}`).toBeGreaterThan(0);
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    fields.set(name, [...(fields.get(name) ?? []), value]);
  }
  return fields;
}

async function fetchSecurityTxt(request: import('@playwright/test').APIRequestContext) {
  const res = await request.get('/.well-known/security.txt');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('text/plain');
  return parseFields(await res.text());
}

test('security.txt is served with the fields RFC 9116 requires', async ({ request }) => {
  const fields = await fetchSecurityTxt(request);

  // Contact and Expires are the only mandatory fields; the other three are the
  // ones #2031 asked for, so they are asserted as requirements here too.
  const contacts = fields.get('contact') ?? [];
  expect(contacts.length).toBeGreaterThan(0);
  for (const contact of contacts) {
    expect(contact).toMatch(/^(https:\/\/|mailto:|tel:)/);
  }

  expect(fields.get('expires')).toHaveLength(1);
  expect(fields.get('policy')?.length).toBeGreaterThan(0);
  expect(fields.get('acknowledgments')?.length).toBeGreaterThan(0);

  const languages = (fields.get('preferred-languages') ?? [])[0] ?? '';
  const codes = languages.split(',').map((l) => l.trim());
  expect(codes).toEqual(expect.arrayContaining(['en', 'tr', 'de']));
});

test('the Expires date is in the future and less than a year out', async ({ request }) => {
  const fields = await fetchSecurityTxt(request);
  const raw = (fields.get('expires') ?? [])[0];
  const expires = new Date(raw!);
  expect(Number.isNaN(expires.getTime()), `unparseable Expires: ${raw}`).toBe(false);

  const now = Date.now();
  const oneYear = 365 * 24 * 60 * 60 * 1000;

  // Past: the file is formally invalid and researchers are told to distrust it.
  expect(
    expires.getTime(),
    `security.txt expired on ${raw} — renew it (see the RENEWAL note in public/.well-known/security.txt)`
  ).toBeGreaterThan(now);

  // Too far out: RFC 9116 § 2.5.5 asks for less than a year, so a "renewal"
  // that just pushes the date out by a decade fails here rather than passing
  // quietly.
  expect(
    expires.getTime() - now,
    `Expires is more than a year out (${raw}); RFC 9116 asks for under a year`
  ).toBeLessThan(oneYear);
});

test('every document security.txt points at exists in the repository', async ({ request }) => {
  const fields = await fetchSecurityTxt(request);
  const referenced = [...(fields.get('policy') ?? []), ...(fields.get('acknowledgments') ?? [])];
  expect(referenced.length).toBeGreaterThan(0);

  for (const url of referenced) {
    expect(url.startsWith(REPO_BLOB), `unexpected host for ${url}`).toBe(true);
    const rel = url.slice(REPO_BLOB.length);
    expect(fs.existsSync(path.join(REPO_ROOT, rel)), `security.txt points at a missing file: ${rel}`).toBe(true);
  }
});

test('the four assurance documents are published and honest about what is missing', () => {
  const read = (rel: string) => {
    const abs = path.join(REPO_ROOT, rel);
    expect(fs.existsSync(abs), `missing assurance document: ${rel}`).toBe(true);
    return fs.readFileSync(abs, 'utf8');
  };

  const vdp = read('docs/trust/vulnerability-disclosure.md');
  const pentest = read('docs/trust/pentest.md');
  const questionnaire = read('docs/trust/questionnaire-answers.md');
  const soc2 = read('docs/trust/soc2-decision.md');

  // The VDP has to state scope, safe harbour and response targets — the three
  // things a reviewer looks for and the three the acceptance criteria name.
  expect(vdp).toMatch(/## 2\. Scope/);
  expect(vdp).toMatch(/Safe harbour/i);
  expect(vdp).toMatch(/5 working days/);
  expect(vdp).toMatch(/security\/advisories\/new/);

  // The pen-test page must carry the open findings rather than imply a clean
  // result. If #1535/#1546/#1539 close, the page changes and so does this list.
  for (const issue of ['1535', '1546', '1539']) {
    expect(pentest, `pentest.md must name open finding #${issue}`).toContain(`#${issue}`);
  }
  expect(pentest).toMatch(/no external penetration test has been commissioned/i);

  // Every questionnaire answer carries an evidence path, so the table rows
  // link somewhere; and the "no" answers stay marked as no.
  expect(questionnaire).toContain('❌');
  expect(questionnaire.match(/\]\(/g)?.length ?? 0).toBeGreaterThan(50);

  // SOC 2 stays a decision document: prerequisites named, no implementation plan.
  expect(soc2).toMatch(/#1515/);
  expect(soc2).toMatch(/#1591/);
  expect(soc2).toMatch(/not started/i);
  expect(soc2).toMatch(/not\*{0,2} an implementation plan/i);
});

test('every Assurance link on the trust page resolves', async ({ request }) => {
  expect(ASSURANCE_LINKS.length).toBeGreaterThan(0);

  for (const link of ASSURANCE_LINKS) {
    // Three locales for every entry — the type system already requires it, so
    // this guards against an empty string slipping through.
    for (const locale of ['en', 'tr', 'de'] as const) {
      expect(link.label[locale].length, `${link.key} has no ${locale} label`).toBeGreaterThan(0);
      expect(link.description[locale].length, `${link.key} has no ${locale} description`).toBeGreaterThan(0);
    }

    if (link.href.startsWith(REPO_BLOB)) {
      const rel = link.href.slice(REPO_BLOB.length);
      expect(fs.existsSync(path.join(REPO_ROOT, rel)), `assurance link ${link.key} → missing ${rel}`).toBe(true);
    } else {
      // An app-relative target must actually be served by this deployment.
      const res = await request.get(link.href);
      expect(res.status(), `assurance link ${link.key} → ${link.href}`).toBe(200);
    }
  }
});
