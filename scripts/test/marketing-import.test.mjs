// Unit tests for the marketing account import (#2404–#2407, story #2391).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// WHY THESE ARE UNIT TESTS AND NOT A BROWSER TEST
//   Four of the properties this importer promises typecheck perfectly while
//   being wrong, and none of them is visible from a page:
//
//     • THE MATCH KEY — VAT id beats name, and the name half must survive
//       İ/ı/ü/ß. `'İstanbul'.toLowerCase()` is "i" plus a combining dot, two
//       code points, so a plain lowercase comparison silently creates a second
//       account for the same merchant on every run;
//     • IDEMPOTENCY — the same file applied twice must change nothing the
//       second time, which is a property of a SEQUENCE of runs against a store;
//     • DRY-RUN HONESTY — the preview is produced by the code that applies, so
//       the same file must plan identically in both modes;
//     • THE ROW CONTRACT — a bad row is reported as ERROR with a reason and
//       never thrown, and a row with a stage but no contact still lands its
//       account.
//
//   So the writer is a port and this file is the in-memory world behind it: no
//   database, no CSV library, about a second.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// The modules under test import each other as `./importPreview` and `@/i18n/…`
// — specifiers the app's bundler resolves and Node's ESM resolver does not. The
// hook must be installed before they load, which is why these imports are
// dynamic (a static import would be hoisted above the register() call).
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));

const {
  accountMatchKey,
  applyPlannedAccounts,
  diffMarketingAccounts,
  makeMarketingValidator,
  normalizeVatKey,
  parseChannels,
  parseMinorUnits,
  previewWriter,
  MARKETING_IMPORT_COLUMNS,
  MARKETING_COLUMNS_WITHOUT_TARGET,
} = await import('../../src/lib/marketingImport.ts');
const { parseDelimited, runImport } = await import('../../src/lib/importPreview.ts');

const STAGES = ['LEAD_NEW', 'LEAD_CONTACTED', 'LEAD_QUALIFIED', 'DEAL_PROPOSAL', 'DEAL_WON', 'DEAL_LOST'];
const OWNER = { id: 'owner-1', email: 'owner@example.com' };

const HEADER =
  'name,legal_name,country,city,vat_id,website,industry,locale,stage,source,monthly_transactions,mrr,owner_email,channels,contact_name,contact_email,contact_phone';

/** The in-memory world behind the writer port. */
function memoryStore(seed = {}) {
  return {
    accounts: seed.accounts ? seed.accounts.map((a) => ({ ...a })) : [],
    leads: seed.leads ? seed.leads.map((l) => ({ ...l })) : [],
    relations: seed.relations ? seed.relations.map((r) => ({ ...r })) : [],
    nextId: 1,
  };
}

function snapshotOf(store) {
  return {
    accounts: store.accounts.map((a) => ({ ...a })),
    leads: store.leads.map((l) => ({ ...l })),
    relations: store.relations.map((r) => ({ ...r })),
  };
}

/** A writer that writes — into the object above. Mirrors the Prisma one. */
function memoryWriter(store) {
  const blank = {
    vatId: null,
    country: null,
    industry: null,
    contactName: null,
    contactEmail: null,
    contactPhone: null,
  };
  const place = (row, companyId) => {
    const funnel = row.value.funnel;
    if (!funnel || !funnel.pending) return;
    let lead = funnel.leadId ? store.leads.find((l) => l.id === funnel.leadId) : null;
    if (!lead) {
      lead = {
        id: `user-${store.nextId++}`,
        email: funnel.emailKey,
        fullName: funnel.leadChanges.fullName ?? funnel.emailKey,
        phone: funnel.leadChanges.phone ?? null,
        city: funnel.leadChanges.city ?? null,
        country: funnel.leadChanges.country ?? null,
        preferredLanguage: funnel.leadChanges.preferredLanguage ?? null,
        referralSource: funnel.leadChanges.referralSource ?? null,
        companyId,
      };
      store.leads.push(lead);
    } else {
      Object.assign(lead, funnel.leadChanges, { companyId });
    }
    const active = store.relations.find((r) => r.menteeId === lead.id && r.status === 'ACTIVE');
    if (active && active.mentorId !== funnel.ownerId) {
      throw new Error('This mentee already has an active mentorship relation');
    }
    if (!active) {
      store.relations.push({
        id: `rel-${store.nextId++}`,
        mentorId: funnel.ownerId,
        menteeId: lead.id,
        companyId,
        pipelineStatus: funnel.toStage,
        status: 'ACTIVE',
      });
      return;
    }
    active.pipelineStatus = funnel.toStage;
    active.companyId = companyId;
  };
  return {
    async createAccount(row) {
      const account = { id: `co-${store.nextId++}`, name: row.value.input.name, ...blank, ...row.value.account.changes };
      store.accounts.push(account);
      place(row, account.id);
      return account.id;
    },
    async updateAccount(row) {
      const account = store.accounts.find((a) => a.id === row.value.account.targetId);
      Object.assign(account, row.value.account.changes);
      place(row, account.id);
      return account.id;
    },
  };
}

/** One run of the real engine against the in-memory world. */
async function runFile(text, store, options = {}) {
  const validate = makeMarketingValidator({ stageKeys: options.stageKeys ?? STAGES });
  const apply = options.apply === true;
  const writer = apply ? memoryWriter(store) : previewWriter;
  return runImport({
    parse: () => parseDelimited(text),
    validate,
    resolve: async (rows) =>
      diffMarketingAccounts(rows, snapshotOf(store), {
        defaultOwnerId: OWNER.id,
        defaultOwnerEmail: OWNER.email,
        ownerIdByEmail: new Map(options.owners ?? []),
        authoritative: options.authoritative === true,
      }),
    apply: (chunk) => applyPlannedAccounts(chunk, writer),
    dryRun: !apply,
  });
}

// ── The column contract (#2404) ──────────────────────────────────────────────

test('the contract declares every column the doc names, and only `name` is required', () => {
  const headers = MARKETING_IMPORT_COLUMNS.map((c) => c.header);
  for (const expected of [
    'name', 'legal_name', 'country', 'city', 'vat_id', 'website', 'industry', 'locale',
    'stage', 'source', 'monthly_transactions', 'mrr', 'owner_email', 'channels',
    'contact_name', 'contact_email', 'contact_phone',
  ]) {
    assert.ok(headers.includes(expected), `missing column ${expected}`);
  }
  assert.deepEqual(MARKETING_IMPORT_COLUMNS.filter((c) => c.required).map((c) => c.header), ['name']);
});

test('no column names a tenant: one run is one organization', () => {
  for (const column of MARKETING_IMPORT_COLUMNS) {
    assert.ok(!/org|tenant|mandant/i.test(column.header), `${column.header} looks like a tenant column`);
  }
});

test('the columns with no database column yet are named, not silently dropped', () => {
  assert.deepEqual([...MARKETING_COLUMNS_WITHOUT_TARGET].sort(), [
    'channels', 'legal_name', 'monthly_transactions', 'mrr', 'website',
  ]);
});

// ── validate (#2406) ─────────────────────────────────────────────────────────

test('a row without a name is an ERROR with a reason, never a throw', async () => {
  const report = await runFile(`${HEADER}\n,,DE,,,,,,,,,,,,,,\n`, memoryStore());
  assert.equal(report.counts.ERROR, 1);
  assert.match(report.rows[0].reason, /name is required/);
});

test('a stage the organization does not have is an ERROR naming the ones it does', async () => {
  const report = await runFile(
    `${HEADER}\nAcme,,DE,,,,,,PROSPECT_100,,,,,,,,\n`,
    memoryStore(),
  );
  assert.equal(report.counts.ERROR, 1);
  assert.match(report.rows[0].reason, /PROSPECT_100/);
  assert.match(report.rows[0].reason, /LEAD_NEW/);
});

test('country must be ISO-3166-1 alpha-2, and a bad locale is refused', async () => {
  const bad = await runFile(`${HEADER}\nAcme,,Germany,,,,,,,,,,,,,,\n`, memoryStore());
  assert.match(bad.rows[0].reason, /alpha-2/);
  const locale = await runFile(`${HEADER}\nAcme,,DE,,,,,fr,,,,,,,,,\n`, memoryStore());
  assert.match(locale.rows[0].reason, /locale/);
});

test('a contact address on the reserved stand-in domain is refused', async () => {
  const report = await runFile(
    `${HEADER}\nAcme,,DE,,,,,,LEAD_NEW,,,,,,Ada,ada@import.local,\n`,
    memoryStore(),
  );
  assert.equal(report.counts.ERROR, 1);
  assert.match(report.rows[0].reason, /stand-in domain/);
});

test('a value longer than its column is refused, not truncated', async () => {
  // A 200-character name would die in the INSERT with P2000 (VARCHAR(191)) and
  // surface as a 500; in a migration a silent truncation is worse still.
  const long = 'A'.repeat(200);
  const tooLong = await runFile(`${HEADER}\n${long},,DE,,,,,,,,,,,,,,\n`, memoryStore());
  assert.equal(tooLong.counts.ERROR, 1);
  assert.match(tooLong.rows[0].reason, /name is longer than 191 characters/);
  // The phone cap is deliberately far below the column: past ~40 characters a
  // "number" is a paste.
  const phone = await runFile(
    `${HEADER}\nAcme,,DE,,,,,,,,,,,,Ada,ada@acme.example,${'1'.repeat(60)}\n`,
    memoryStore(),
  );
  assert.match(phone.rows[0].reason, /contactPhone is longer than 40 characters/);
});

test('money is parsed to integer minor units in both separator conventions', () => {
  assert.equal(parseMinorUnits('1.234,50'), 123450);
  assert.equal(parseMinorUnits('1,234.50'), 123450);
  assert.equal(parseMinorUnits('990'), 99000);
  assert.equal(parseMinorUnits('1.234'), 123400);
  assert.equal(parseMinorUnits(''), null);
  assert.ok(Number.isNaN(parseMinorUnits('n/a')));
});

test('channels split on ";", trim and de-duplicate', () => {
  assert.deepEqual(parseChannels('Amazon; eBay ;OTTO; amazon'), ['Amazon', 'eBay', 'OTTO']);
  assert.deepEqual(parseChannels(''), []);
});

// ── resolve: the match key (#2405) ───────────────────────────────────────────

test('VAT id wins over the name: a renamed merchant is one account, not two', async () => {
  const store = memoryStore({
    accounts: [{ id: 'co-old', name: 'Old Name GmbH', vatId: 'DE123456789', country: 'DE', industry: null, contactName: null, contactEmail: null, contactPhone: null }],
  });
  const report = await runFile(
    `${HEADER}\nBrand New GmbH,,DE,,DE 123.456.789,,,,,,,,,,,,\n`,
    store,
    { apply: true, authoritative: true },
  );
  assert.equal(report.counts.UPDATE, 1);
  assert.equal(report.counts.CREATE, 0);
  assert.equal(store.accounts.length, 1);
  assert.equal(store.accounts[0].name, 'Brand New GmbH');
});

test('the VAT key ignores spacing and case, and refuses a too-short value', () => {
  assert.equal(normalizeVatKey('de 123.456-789'), 'DE123456789');
  assert.equal(normalizeVatKey('DE1'), '');
  assert.equal(normalizeVatKey(null), '');
});

test('Turkish and German names match through the shared normalizer', async () => {
  const store = memoryStore({
    accounts: [
      { id: 'co-tr', name: 'İstanbul Tekstil A.Ş.', vatId: null, country: 'TR', industry: null, contactName: null, contactEmail: null, contactPhone: null },
      { id: 'co-de', name: 'Grüße Straße GmbH', vatId: null, country: 'DE', industry: null, contactName: null, contactEmail: null, contactPhone: null },
    ],
  });
  const report = await runFile(
    `${HEADER}\nISTANBUL TEKSTIL A.S.,,TR,,,,Retail,,,,,,,,,,\nGrüsse Strasse GmbH,,DE,,,,,,,,,,,,,,\n`,
    store,
    { apply: true },
  );
  // Row 1 matches through İ→I and Ş→S. A plain `toLowerCase()` would not:
  // 'İ'.toLowerCase() is "i" plus a combining dot, two code points, so the
  // stored name and this spelling would compare unequal and the run would
  // create a twin account on every pass.
  assert.equal(report.rows[0].status, 'UPDATE');
  assert.equal(report.rows[0].targetId, 'co-tr');
  // Row 2: ß does NOT transliterate to "ss" — "Grüsse Strasse" is a different
  // spelling and the importer must not silently fold two merchants into one.
  assert.equal(report.rows[1].status, 'CREATE');
  assert.equal(store.accounts.length, 3);
});

test('the same name in two countries is two accounts', () => {
  const de = accountMatchKey({ name: 'Acme', country: 'DE', vatId: '' });
  const tr = accountMatchKey({ name: 'Acme', country: 'TR', vatId: '' });
  assert.notEqual(de, tr);
});

test('two rows for one account in one file: the first wins, the second is a SKIP', async () => {
  const report = await runFile(
    `${HEADER}\nAcme,,DE,,DE123456789,,,,,,,,,,,,\nAcme Holding,,DE,,DE 123 456 789,,,,,,,,,,,,\n`,
    memoryStore(),
  );
  assert.equal(report.counts.CREATE, 1);
  assert.equal(report.counts.SKIP, 1);
  assert.match(report.rows[1].reason, /duplicate account in file \(first seen at row 1\)/);
});

// ── apply + idempotency (#2391/#2405) ────────────────────────────────────────

const FIXTURE_TEXT = [
  HEADER,
  'Nordlicht Handel GmbH,Nordlicht Handel GmbH,DE,Hamburg,DE811234567,https://nordlicht.example,Retail,de,LEAD_QUALIFIED,Messe,420,"1.250,00",,Amazon;eBay;OTTO,Lena Sommer,lena@nordlicht.example,+49 40 1234567',
  'İstanbul Tekstil,,TR,İstanbul,,https://ist.example,Textile,tr,LEAD_NEW,Referans,90,0,,,Ayşe Yıldız,ayse@ist.example,+90 555 123 45 67',
  'Depot Nord,,DE,Kiel,DE999888777,,Logistics,de,DEAL_WON,Empfehlung,1200,"3.400,00",,Shopify,,,',
].join('\n');

test('a second apply of the same file is all UNCHANGED', async () => {
  const store = memoryStore();
  const first = await runFile(FIXTURE_TEXT, store, { apply: true });
  assert.equal(first.counts.CREATE, 3);
  assert.equal(first.counts.ERROR, 0);
  assert.equal(store.accounts.length, 3);
  assert.equal(store.leads.length, 2, 'the contact-less row creates no lead');
  assert.equal(store.relations.length, 2);

  const second = await runFile(FIXTURE_TEXT, store, { apply: true });
  assert.equal(second.counts.UNCHANGED, 3);
  assert.equal(second.counts.CREATE, 0);
  assert.equal(second.counts.UPDATE, 0);
  assert.equal(store.accounts.length, 3);
  assert.equal(store.leads.length, 2);
  assert.equal(store.relations.length, 2);
});

test('a row with a stage but no contact keeps its account and warns about the stage', async () => {
  const store = memoryStore();
  const report = await runFile(FIXTURE_TEXT, store, { apply: true });
  const row = report.rows.find((r) => r.value.input.name === 'Depot Nord');
  assert.equal(row.status, 'CREATE');
  assert.match(row.reason, /no primary contact e-mail/);
  assert.ok(store.accounts.some((a) => a.name === 'Depot Nord'));
  assert.equal(store.relations.filter((r) => r.pipelineStatus === 'DEAL_WON').length, 0);
});

test('the lead person is created from the primary contact and carries the account', async () => {
  const store = memoryStore();
  await runFile(FIXTURE_TEXT, store, { apply: true });
  const lead = store.leads.find((l) => l.email === 'lena@nordlicht.example');
  assert.equal(lead.fullName, 'Lena Sommer');
  assert.equal(lead.preferredLanguage, 'de');
  assert.equal(lead.referralSource, 'Messe');
  assert.equal(lead.city, 'Hamburg');
  const account = store.accounts.find((a) => a.name === 'Nordlicht Handel GmbH');
  assert.equal(lead.companyId, account.id);
  assert.equal(account.contactName, 'Lena Sommer');
  assert.equal(account.contactPhone, '+49 40 1234567');
  const relation = store.relations.find((r) => r.menteeId === lead.id);
  assert.equal(relation.mentorId, OWNER.id);
  assert.equal(relation.companyId, account.id);
  assert.equal(relation.pipelineStatus, 'LEAD_QUALIFIED');
});

test('a stage move on an existing funnel record is an UPDATE, not a second record', async () => {
  const store = memoryStore();
  await runFile(FIXTURE_TEXT, store, { apply: true });
  const moved = FIXTURE_TEXT.replace('LEAD_QUALIFIED', 'DEAL_PROPOSAL');
  const report = await runFile(moved, store, { apply: true });
  assert.equal(report.counts.UPDATE, 1);
  assert.equal(store.relations.length, 2);
  const lead = store.leads.find((l) => l.email === 'lena@nordlicht.example');
  assert.equal(store.relations.find((r) => r.menteeId === lead.id).pipelineStatus, 'DEAL_PROPOSAL');
});

test('a re-spelled phone number is not a change', async () => {
  const store = memoryStore();
  await runFile(FIXTURE_TEXT, store, { apply: true });
  const respelled = FIXTURE_TEXT.replace('+90 555 123 45 67', '0555-123-4567');
  const report = await runFile(respelled, store, { apply: true, authoritative: true });
  assert.equal(report.counts.UNCHANGED, 3);
});

test('the lead of a row whose contact already has another owner is an ERROR, not a theft', async () => {
  const store = memoryStore({
    leads: [{ id: 'user-x', email: 'lena@nordlicht.example', fullName: 'Lena Sommer', phone: null, city: null, country: null, preferredLanguage: null, referralSource: null, companyId: null }],
    relations: [{ id: 'rel-x', mentorId: 'other-owner', menteeId: 'user-x', companyId: null, pipelineStatus: 'LEAD_NEW', status: 'ACTIVE' }],
  });
  const report = await runFile(FIXTURE_TEXT, store, { apply: true });
  const row = report.rows.find((r) => r.value.input.name === 'Nordlicht Handel GmbH');
  assert.equal(row.status, 'ERROR');
  assert.match(row.reason, /active mentorship/i);
  assert.equal(store.relations.find((r) => r.id === 'rel-x').mentorId, 'other-owner');
  // The other two rows still landed: one refused row does not cost the chunk.
  assert.equal(report.counts.CREATE, 2);
});

// ── dry-run honesty ──────────────────────────────────────────────────────────

test('the dry run plans exactly what the apply plans, and writes nothing', async () => {
  const dryStore = memoryStore();
  const preview = await runFile(FIXTURE_TEXT, dryStore);
  assert.equal(dryStore.accounts.length, 0);
  assert.equal(dryStore.leads.length, 0);
  assert.equal(dryStore.relations.length, 0);
  assert.equal(preview.dryRun, true);

  const realStore = memoryStore();
  const applied = await runFile(FIXTURE_TEXT, realStore, { apply: true });
  assert.deepEqual(preview.counts, applied.counts);
  assert.deepEqual(
    preview.rows.map((r) => [r.row, r.status, r.key, (r.changed ?? []).join('|')]),
    applied.rows.map((r) => [r.row, r.status, r.key, (r.changed ?? []).join('|')]),
  );
});

test('nothing is reported absent: an account spreadsheet is a partial list', async () => {
  const store = memoryStore({
    accounts: [{ id: 'co-untouched', name: 'Never Mentioned AG', vatId: null, country: 'DE', industry: null, contactName: null, contactEmail: null, contactPhone: null }],
  });
  const report = await runFile(FIXTURE_TEXT, store);
  assert.deepEqual(report.absent, []);
});

// ── owner column ─────────────────────────────────────────────────────────────

test('owner_email picks a different owner in the same organization', async () => {
  const store = memoryStore();
  const text = `${HEADER}\nAcme,,DE,,,,,,LEAD_NEW,,,,second@example.com,,Ada,ada@acme.example,\n`;
  const report = await runFile(text, store, {
    apply: true,
    owners: [['second@example.com', 'owner-2']],
  });
  assert.equal(report.counts.CREATE, 1);
  assert.equal(store.relations[0].mentorId, 'owner-2');
});

test('an owner_email nobody in the organization has keeps the account and warns', async () => {
  const store = memoryStore();
  const text = `${HEADER}\nAcme,,DE,,,,,,LEAD_NEW,,,,ghost@example.com,,Ada,ada@acme.example,\n`;
  const report = await runFile(text, store, { apply: true });
  assert.equal(report.counts.CREATE, 1);
  assert.match(report.rows[0].reason, /not a user of this organization/);
  assert.equal(store.accounts.length, 1);
  assert.equal(store.relations.length, 0);
});
