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
  funnelRelationCreateData,
  funnelRelationUpdateData,
  leadStandInEmail,
  normalizeExternalIdKey,
  parseImportDate,
  IMPORT_DATE_YEARS,
  makeMarketingValidator,
  normalizeVatKey,
  parseChannels,
  parseMinorUnits,
  previewWriter,
  MARKETING_IMPORT_COLUMNS,
  MARKETING_COLUMNS_WITHOUT_TARGET,
} = await import('../../src/lib/marketingImport.ts');
const { importErrorMessage, parseDelimited, runImport } = await import('../../src/lib/importPreview.ts');
// The real refusal the production writer throws — not a message this file
// invents. Its `message` is the literal 'already_mentored', so a test asserting
// an English sentence on a fake would prove nothing about what an operator sees.
const { AlreadyMentoredError } = await import('../../src/lib/activeMentorship.ts');

const STAGES = ['LEAD_NEW', 'LEAD_CONTACTED', 'LEAD_QUALIFIED', 'DEAL_PROPOSAL', 'DEAL_WON', 'DEAL_LOST'];
const OWNER = { id: 'owner-1', email: 'owner@example.com' };
const ORG = 'org-1';
/** The address a lead CREATED by the import carries (see #2407 in the module). */
const standIn = (contactEmail) => leadStandInEmail(contactEmail, ORG);

const HEADER =
  'name,legal_name,country,city,vat_id,website,industry,locale,stage,source,monthly_transactions,mrr,owner_email,channels,contact_name,contact_email,contact_phone';

/** The in-memory world behind the writer port. */
function memoryStore(seed = {}) {
  return {
    accounts: seed.accounts ? seed.accounts.map((a) => ({ ...a })) : [],
    leads: seed.leads ? seed.leads.map((l) => ({ ...l })) : [],
    relations: seed.relations ? seed.relations.map((r) => ({ ...r })) : [],
    nextId: 1,
    /** The writer's clock and the org's trial length (#2554 tests pin both). */
    now: seed.now,
    trialLengthDays: seed.trialLengthDays,
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
    externalId: null,
  };
  const place = (row, companyId) => {
    const funnel = row.value.funnel;
    if (!funnel || !funnel.pending) return;
    let lead = funnel.leadId ? store.leads.find((l) => l.id === funnel.leadId) : null;
    if (!lead) {
      lead = {
        id: `user-${store.nextId++}`,
        // The stand-in, never the merchant's mailbox — mirrors the Prisma writer.
        email: funnel.leadEmail,
        fullName: funnel.leadChanges.fullName ?? funnel.leadEmail,
        phone: funnel.leadChanges.phone ?? null,
        city: funnel.leadChanges.city ?? null,
        country: funnel.leadChanges.country ?? null,
        preferredLanguage: funnel.leadChanges.preferredLanguage ?? null,
        referralSource: funnel.leadChanges.referralSource ?? null,
        companyId,
        // The Prisma writer resolves the tenant Source by name; the name stands in.
        sourceId: funnel.sourceName ? `src:${funnel.sourceName}` : null,
        referredById: null,
      };
      store.leads.push(lead);
    } else {
      Object.assign(lead, funnel.leadChanges, { companyId });
      // First touch (#2570), as the Prisma writer's conditional updateMany.
      if (funnel.sourceName && !lead.sourceId && !lead.referredById) lead.sourceId = `src:${funnel.sourceName}`;
    }
    const active = store.relations.find((r) => r.menteeId === lead.id && r.status === 'ACTIVE');
    if (active && active.mentorId !== funnel.ownerId) {
      throw new AlreadyMentoredError(lead.id, active.id);
    }
    // The relation data comes from the SAME builders the Prisma writer spreads
    // (#2551/#2554), so the dates this world holds are the ones production writes.
    const now = store.now ?? new Date();
    const trialLengthDays = store.trialLengthDays ?? 30;
    if (!active) {
      const data = funnelRelationCreateData(funnel, lead.id, { orgId: ORG, companyId, now, trialLengthDays });
      store.relations.push({
        id: `rel-${store.nextId++}`,
        status: 'ACTIVE',
        trialStartedAt: null,
        trialEndsAt: null,
        ...data,
        // `@default(now())` on the column.
        startDate: data.startDate ?? now,
        // The estimated value (#2422) — `writeImportedValue` in the Prisma writer.
        valueMinor: funnel.valueMinor,
        valueCurrency: funnel.valueMinor !== null ? 'EUR' : null,
      });
      return;
    }
    Object.assign(active, funnelRelationUpdateData(funnel, active, { companyId, now, trialLengthDays }));
    if (funnel.valueMinor !== null) {
      active.valueMinor = funnel.valueMinor;
      active.valueCurrency = 'EUR'; // the file's mrr is always EUR
    }
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
        orgKey: ORG,
        authoritative: options.authoritative === true,
        trialLengthDays: store.trialLengthDays,
        ...(store.now ? { now: store.now } : {}),
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

test('an account stored before this change — country NULL — matches a row that names one', async () => {
  // THE REGRESSION THIS PINS. `Company.country` and `Company.vatId` arrive with
  // this feature, so on the first run every account the tenant already holds
  // has both NULL. An exact name+country key reads the stored "acme gmbh␀" and
  // the file's "acme gmbh␀DE" as two merchants and duplicates the entire
  // account master — invisibly, because `absent` is empty and the NEXT run
  // matches the fresh twin and reports UNCHANGED.
  const store = memoryStore({
    accounts: [{ id: 'co-existing', name: 'Nordlicht Handel GmbH', vatId: null, country: null, industry: null, contactName: null, contactEmail: null, contactPhone: null }],
  });
  const report = await runFile(
    `${HEADER}\nNordlicht Handel GmbH,,DE,Hamburg,,,Retail,,,,,,,,,,\n`,
    store,
    { apply: true },
  );
  assert.equal(report.counts.CREATE, 0);
  assert.equal(report.counts.UPDATE, 1);
  assert.equal(report.rows[0].targetId, 'co-existing');
  assert.equal(store.accounts.length, 1);
  // The country is filled in as a gap, so the run after this one keys exactly.
  assert.equal(store.accounts[0].country, 'DE');
  const second = await runFile(
    `${HEADER}\nNordlicht Handel GmbH,,DE,Hamburg,,,Retail,,,,,,,,,,\n`,
    store,
    { apply: true },
  );
  assert.equal(second.counts.UNCHANGED, 1);
  assert.equal(store.accounts.length, 1);
});

test('the mirror case: a stored country and a file that omits it still match', async () => {
  const store = memoryStore({
    accounts: [{ id: 'co-de', name: 'Depot Nord', vatId: null, country: 'DE', industry: null, contactName: null, contactEmail: null, contactPhone: null }],
  });
  const report = await runFile(`${HEADER}\nDepot Nord,,,,,,Logistics,,,,,,,,,,\n`, store, { apply: true });
  assert.equal(report.counts.UPDATE, 1);
  assert.equal(store.accounts.length, 1);
});

test('two countries and a countryless row is ambiguous — reported, never guessed', async () => {
  const store = memoryStore({
    accounts: [
      { id: 'co-de', name: 'Acme', vatId: null, country: 'DE', industry: null, contactName: null, contactEmail: null, contactPhone: null },
      { id: 'co-tr', name: 'Acme', vatId: null, country: 'TR', industry: null, contactName: null, contactEmail: null, contactPhone: null },
    ],
  });
  const report = await runFile(`${HEADER}\nAcme,,,,,,Retail,,,,,,,,,,\n`, store, { apply: true });
  assert.equal(report.counts.SKIP, 1);
  assert.equal(report.counts.CREATE, 0);
  assert.match(report.rows[0].reason, /ambiguous: 2 existing accounts/);
  assert.equal(store.accounts.length, 2, 'an ambiguous row writes nothing');
});

test('the same merchant twice in one file — VAT on one line only — is one account', async () => {
  // The guard keys on the account a row RESOLVES to, not the identity it
  // CLAIMS: `vat:DE123456789` and `name:acme gmbh␀DE` are two different claimed
  // keys for one merchant, and a claim-keyed guard never fires.
  const store = memoryStore();
  const report = await runFile(
    `${HEADER}\nAcme GmbH,,DE,,DE123456789,,,,,,,,,,,,\nAcme GmbH,,DE,,,,,,,,,,,,,,\n`,
    store,
    { apply: true },
  );
  assert.equal(report.counts.CREATE, 1);
  assert.equal(report.counts.SKIP, 1);
  assert.match(report.rows[1].reason, /duplicate account in file \(first seen at row 1\)/);
  assert.equal(store.accounts.length, 1);
});

test('two rows resolving onto one EXISTING account: the second is a SKIP, not a double write', async () => {
  const store = memoryStore({
    accounts: [{ id: 'co-1', name: 'Acme GmbH', vatId: 'DE123456789', country: 'DE', industry: null, contactName: null, contactEmail: null, contactPhone: null }],
  });
  const report = await runFile(
    `${HEADER}\nAcme GmbH,,DE,,DE123456789,,Retail,,,,,,,,,,\nAcme GmbH,,DE,,,,Logistics,,,,,,,,,,\n`,
    store,
    { apply: true },
  );
  assert.equal(report.counts.SKIP, 1);
  assert.match(report.rows[1].reason, /duplicate account in file \(first seen at row 1\)/);
  assert.equal(store.accounts[0].industry, 'Retail');
});

test('two genuinely different merchants of the same name in one file are two accounts', async () => {
  const store = memoryStore();
  const report = await runFile(
    `${HEADER}\nAcme,,DE,,,,,,,,,,,,,,\nAcme,,TR,,,,,,,,,,,,,,\n`,
    store,
    { apply: true },
  );
  assert.equal(report.counts.CREATE, 2);
  assert.equal(report.counts.SKIP, 0);
  assert.equal(store.accounts.length, 2);
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

test('the mrr column lands as the record\'s estimated value, gap-fill unless authoritative (#2422)', async () => {
  const store = memoryStore();
  await runFile(FIXTURE_TEXT, store, { apply: true });
  const lead = store.leads.find((l) => l.email === standIn('lena@nordlicht.example'));
  const relation = store.relations.find((r) => r.menteeId === lead.id);
  assert.equal(relation.valueMinor, 125000, '"1.250,00" is 125 000 cents — integer, never a float');
  // An mrr of 0 is a value (a free account), not "no opinion".
  const ayse = store.leads.find((l) => l.email === standIn('ayse@ist.example'));
  assert.equal(store.relations.find((r) => r.menteeId === ayse.id).valueMinor, 0);

  // A rep re-estimates the account; the next run of the old file leaves it alone …
  relation.valueMinor = 99000;
  const gapFill = await runFile(FIXTURE_TEXT, store, { apply: true });
  assert.equal(relation.valueMinor, 99000);
  const row = gapFill.rows.find((r) => r.value.input.name === 'Nordlicht Handel GmbH');
  assert.equal(row.status, 'UNCHANGED');
  assert.match(row.reason, /left alone: estimated value/);

  // … and only an authoritative run overwrites it.
  const authoritative = await runFile(FIXTURE_TEXT, store, { apply: true, authoritative: true });
  assert.equal(relation.valueMinor, 125000);
  assert.ok(authoritative.rows.find((r) => r.value.input.name === 'Nordlicht Handel GmbH').changed.includes('value'));
});

test('the mrr comparison is amount AND currency: a CHF estimate is a disagreement (#2422)', async () => {
  const store = memoryStore();
  await runFile(FIXTURE_TEXT, store, { apply: true });
  const lead = store.leads.find((l) => l.email === standIn('lena@nordlicht.example'));
  const relation = store.relations.find((r) => r.menteeId === lead.id);
  // Same amount as the file's "1.250,00", different currency.
  relation.valueCurrency = 'CHF';
  const gapFill = await runFile(FIXTURE_TEXT, store, { apply: true });
  const row = gapFill.rows.find((r) => r.value.input.name === 'Nordlicht Handel GmbH');
  assert.match(row.reason, /left alone: estimated value/, 'withheld, not "no change"');
  assert.equal(relation.valueCurrency, 'CHF');

  await runFile(FIXTURE_TEXT, store, { apply: true, authoritative: true });
  assert.equal(relation.valueCurrency, 'EUR', 'the authoritative source says EUR');
  assert.equal(relation.valueMinor, 125000);
});

test('an mrr above the deal-value bound refuses the row with a reason (#2422)', async () => {
  const store = memoryStore();
  // 21 474 836,48 € — past the MySQL INT the value lives in; and 10 000 000,01 €,
  // past the bound the editor enforces. Both must be a named refusal.
  for (const mrr of ['"21.474.836,48"', '"10.000.000,01"']) {
    const text = [HEADER, `Big GmbH,,DE,Kiel,,,Retail,de,DEAL_WON,Messe,1,${mrr},,,Bo,bo@big.example,`].join('\n');
    const report = await runFile(text, store, { apply: true });
    assert.equal(report.counts.ERROR, 1, mrr);
    assert.match(report.rows[0].reason, /mrr is too large/);
  }
  assert.equal(store.relations.length, 0);
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
  const lead = store.leads.find((l) => l.email === standIn('lena@nordlicht.example'));
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
  const lead = store.leads.find((l) => l.email === standIn('lena@nordlicht.example'));
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
  // The operator reads a sentence, not the API's `already_mentored` code — and
  // the sentence names the contact, so the refusal can be acted on.
  assert.match(row.reason, /lena@nordlicht\.example already has an active owner/);
  assert.match(row.reason, /already_mentored/);
  assert.equal(store.relations.find((r) => r.id === 'rel-x').mentorId, 'other-owner');
  // The other two rows still landed: one refused row does not cost the chunk.
  assert.equal(report.counts.CREATE, 2);
});

// ── the lead person is a record, not a login (#2407) ─────────────────────────

test('the lead User is created on a stand-in address, never the merchant mailbox', async () => {
  // A funnel record needs a `User` (the relation's `menteeId` is a required FK),
  // but that row must not be a login somebody can claim. A sentinel password is
  // not enough on its own: `/api/auth/forgot` mails a reset link to ANY existing
  // user and `/api/auth/reset` consumes it, neither asking `isPendingActivation`.
  // What makes the recovery path a dead end is the ADDRESS
  // (src/lib/menteeAccount.ts says so) — so the real mailbox stays on the
  // Company row and the lead gets a generated one.
  const store = memoryStore();
  await runFile(FIXTURE_TEXT, store, { apply: true });
  for (const lead of store.leads) {
    assert.ok(lead.email.endsWith('@import.local'), `${lead.email} is a real mailbox`);
  }
  assert.ok(!store.leads.some((l) => l.email === 'lena@nordlicht.example'));
  const account = store.accounts.find((a) => a.name === 'Nordlicht Handel GmbH');
  assert.equal(account.contactEmail, 'lena@nordlicht.example', 'the real address is on the account');
});

test('the stand-in is derived, so the same contact resolves to the same lead next run', () => {
  assert.equal(standIn('lena@nordlicht.example'), standIn('lena@nordlicht.example'));
  // Two organizations importing one contact must not collide: `User.email` is
  // globally unique, so a shared stand-in would be a cross-tenant P2002.
  assert.notEqual(
    leadStandInEmail('lena@nordlicht.example', 'org-1'),
    leadStandInEmail('lena@nordlicht.example', 'org-2'),
  );
  assert.notEqual(standIn('lena@nordlicht.example'), standIn('other@nordlicht.example'));
});

test('a person already in the CRM under their real address is reused, not duplicated', async () => {
  const store = memoryStore({
    leads: [{ id: 'user-real', email: 'lena@nordlicht.example', fullName: 'Lena Sommer', phone: null, city: null, country: null, preferredLanguage: null, referralSource: null, companyId: null }],
  });
  const report = await runFile(FIXTURE_TEXT, store, { apply: true });
  assert.equal(report.counts.ERROR, 0);
  assert.equal(store.leads.length, 2, 'the existing person is reused');
  assert.ok(store.relations.some((r) => r.menteeId === 'user-real'));
});

// ── lead-source attribution (#2570) ─────────────────────────────────────────

test('a new lead is attributed to the typed source; a second apply is still all UNCHANGED', async () => {
  const store = memoryStore();
  await runFile(FIXTURE_TEXT, store, { apply: true });
  const lead = store.leads.find((l) => l.email === standIn('lena@nordlicht.example'));
  assert.equal(lead.sourceId, 'src:Messe');
  const second = await runFile(FIXTURE_TEXT, store, { apply: true });
  assert.equal(second.counts.UNCHANGED, 3, 'an attributed lead plans no further binding');
});

test('re-importing a lead that predates attribution binds it, though its referralSource is unchanged', async () => {
  // The review's case: the lead already says "Messe" in free text, so the diff's
  // `leadChanges` omits referralSource — the binding must not be read from there.
  const store = memoryStore();
  await runFile(FIXTURE_TEXT, store, { apply: true });
  for (const l of store.leads) l.sourceId = null;
  const preview = await runFile(FIXTURE_TEXT, store);
  const row = preview.rows.find((r) => r.value.input.name === 'Nordlicht Handel GmbH');
  assert.equal(row.status, 'UPDATE');
  assert.deepEqual(row.changed, ['lead.source']);
  assert.equal(row.value.funnel.sourceName, 'Messe');
  assert.equal(store.leads.find((l) => l.email === standIn('lena@nordlicht.example')).sourceId, null, 'a dry run binds nothing');

  await runFile(FIXTURE_TEXT, store, { apply: true });
  assert.equal(store.leads.find((l) => l.email === standIn('lena@nordlicht.example')).sourceId, 'src:Messe');
  const third = await runFile(FIXTURE_TEXT, store, { apply: true });
  assert.equal(third.counts.UNCHANGED, 3);
});

test('a lead that already has a referrer of either kind plans no source (first touch)', async () => {
  const store = memoryStore();
  await runFile(FIXTURE_TEXT, store, { apply: true });
  const lena = store.leads.find((l) => l.email === standIn('lena@nordlicht.example'));
  const ayse = store.leads.find((l) => l.email === standIn('ayse@ist.example'));
  lena.sourceId = 'src:Partner X';
  ayse.sourceId = null;
  ayse.referredById = 'user-referrer';
  const report = await runFile(FIXTURE_TEXT, store);
  for (const r of report.rows.filter((r) => r.value.funnel)) {
    assert.equal(r.value.funnel.sourceName, null, `${r.value.input.name}: no Source to create`);
  }
  assert.equal(report.counts.UNCHANGED, 3);
});

test('a caller-decided source name wins over the typed column, and null means no source', async () => {
  const store = memoryStore();
  const validate = makeMarketingValidator({ stageKeys: STAGES });
  const plan = (leadSourceName) =>
    runImport({
      parse: () => parseDelimited(FIXTURE_TEXT),
      validate,
      resolve: async (r) =>
        diffMarketingAccounts(r, snapshotOf(store), {
          defaultOwnerId: OWNER.id,
          defaultOwnerEmail: OWNER.email,
          ownerIdByEmail: new Map(),
          orgKey: ORG,
          authoritative: false,
          leadSourceName,
        }),
      apply: (chunk) => applyPlannedAccounts(chunk, previewWriter),
      dryRun: true,
    });
  const fixed = await plan('utm:linkedin/social/autumn-2026');
  const unknown = await plan(null);
  const withFunnel = (report) => report.rows.filter((r) => r.value.funnel).map((r) => r.value.funnel.sourceName);
  assert.deepEqual(withFunnel(fixed), ['utm:linkedin/social/autumn-2026', 'utm:linkedin/social/autumn-2026']);
  assert.deepEqual(withFunnel(unknown), [null, null]);
});

// ── the ERROR row carries a reason an operator can act on (#2406) ────────────

test('a Prisma-shaped failure does not report an EMPTY reason', async () => {
  // Prisma formats every known request error starting with a BLANK LINE, so the
  // old `split('\n')[0]` produced "" for exactly the failures a writer raises:
  // the operator lost a row and was told nothing. P2002 on `User.email` is the
  // realistic one — a contact whose address already belongs to another tenant.
  const prismaish = Object.assign(
    new Error('\nInvalid `prisma.user.create()` invocation:\n\nUnique constraint failed on the fields: (`email`)'),
    { code: 'P2002', name: 'PrismaClientKnownRequestError' },
  );
  assert.equal(prismaish.message.split('\n')[0], '', 'the message really does start blank');
  const reason = importErrorMessage(prismaish);
  assert.ok(reason.length > 0);
  // The searchable code, then the sentence that says what went wrong — not the
  // "Invalid `prisma.user.create()` invocation:" banner that precedes it.
  assert.equal(reason, 'P2002: Unique constraint failed on the fields: (`email`)');

  // A validation error puts the argument echo between the banner and the
  // sentence. The echo is the query — it is skipped, never persisted.
  const validationish = new Error('\nInvalid `prisma.user.create()` invocation:\n\n{\n  data: {\n+   email: String\n  }\n}\n\nArgument `email` is missing.');
  const validationReason = importErrorMessage(validationish);
  assert.equal(validationReason, 'Argument `email` is missing.');
  assert.ok(!/[{}]/.test(validationReason));

  const thrower = {
    async createAccount() {
      throw prismaish;
    },
    async updateAccount() {
      throw prismaish;
    },
  };
  const results = await applyPlannedAccounts(
    [{ row: 1, key: 'name:acme', status: 'CREATE', value: { input: { name: 'Acme' }, account: { targetId: null, changes: {}, changed: [], withheld: [] }, funnel: null, warnings: [] } }],
    thrower,
  );
  assert.equal(results[0].status, 'ERROR');
  assert.match(results[0].reason, /P2002/);
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

// ── The funnel record's data blocks and the trial window (#2551) ─────────────
//
// The import never calls emitStageChange() (stand-in leads must not be
// notified), so the data block it writes is the ONLY place a record created in
// TRIAL_ACTIVE can get its trial dates. The store spreads these builders
// verbatim into its create/update.

const TRIAL_NOW = new Date('2026-05-04T09:00:00.000Z');
const TRIAL_DAY = 24 * 60 * 60 * 1000;

test('a record the import creates in TRIAL_ACTIVE gets a trial window', () => {
  const data = funnelRelationCreateData({ ownerId: OWNER.id, toStage: 'TRIAL_ACTIVE' }, 'lead-1', {
    orgId: ORG,
    companyId: 'co-1',
    now: TRIAL_NOW,
    trialLengthDays: 30,
  });
  assert.equal(data.pipelineStatus, 'TRIAL_ACTIVE');
  assert.equal(data.mentorId, OWNER.id);
  assert.equal(data.menteeId, 'lead-1');
  assert.equal(data.companyId, 'co-1');
  assert.equal(data.orgId, ORG);
  assert.equal(data.trialStartedAt.toISOString(), TRIAL_NOW.toISOString());
  assert.equal(data.trialEndsAt.getTime() - TRIAL_NOW.getTime(), 30 * TRIAL_DAY);
});

test('a record the import creates at any other stage carries no trial dates', () => {
  const data = funnelRelationCreateData({ ownerId: OWNER.id, toStage: 'LEAD_QUALIFIED' }, 'lead-1', {
    orgId: ORG,
    companyId: 'co-1',
    now: TRIAL_NOW,
    trialLengthDays: 30,
  });
  assert.equal('trialStartedAt' in data, false);
  assert.equal('trialEndsAt' in data, false);
});

test('an import that MOVES an existing record into TRIAL_ACTIVE stamps it; the org length is used', () => {
  const data = funnelRelationUpdateData(
    { toStage: 'TRIAL_ACTIVE' },
    { pipelineStatus: 'LEAD_QUALIFIED', trialStartedAt: null, trialEndsAt: null },
    { companyId: 'co-1', now: TRIAL_NOW, trialLengthDays: 14 },
  );
  assert.equal(data.pipelineStatus, 'TRIAL_ACTIVE');
  assert.equal(data.companyId, 'co-1');
  assert.equal(data.trialEndsAt.getTime() - TRIAL_NOW.getTime(), 14 * TRIAL_DAY);
});

test('an import never overwrites a window, and re-applying the same stage is not an entry', () => {
  const existing = { trialStartedAt: new Date('2026-04-01T00:00:00Z'), trialEndsAt: new Date('2026-05-01T00:00:00Z') };
  // Back into TRIAL_ACTIVE from TRIAL_EXPIRED: the first window stands.
  const back = funnelRelationUpdateData(
    { toStage: 'TRIAL_ACTIVE' },
    { pipelineStatus: 'TRIAL_EXPIRED', ...existing },
    { companyId: 'co-1', now: TRIAL_NOW, trialLengthDays: 30 },
  );
  assert.equal('trialEndsAt' in back, false);
  // A re-run of the same file against a legacy TRIAL_ACTIVE record with no
  // window: the file did not move it, so today is not its trial start.
  const rerun = funnelRelationUpdateData(
    { toStage: 'TRIAL_ACTIVE' },
    { pipelineStatus: 'TRIAL_ACTIVE', trialStartedAt: null, trialEndsAt: null },
    { companyId: 'co-1', now: TRIAL_NOW, trialLengthDays: 30 },
  );
  assert.equal('trialEndsAt' in rerun, false);
});

// ── One lead typed in by hand (#2562) ────────────────────────────────────────
//
// The "new lead / account" form is a file of ONE row run through this very
// engine in create-only mode: the row is built by `manualAccountTable`, planned
// by `diffMarketingAccounts`, and written by `createOnlyWriter` — which creates
// through the real writer and never updates. These pin the answers the route
// turns into responses: created, "already exists", "contact is already a lead".

const { manualAccountTable, createOnlyPlan, createOnlyWriter, CONTACT_IN_FUNNEL } = await import(
  '../../src/lib/marketingImport.ts'
);

async function runManual(fields, store) {
  const writer = createOnlyWriter(memoryWriter(store));
  return runImport({
    parse: () => manualAccountTable(fields),
    validate: makeMarketingValidator({ stageKeys: STAGES }),
    resolve: async (rows) =>
      diffMarketingAccounts(rows, snapshotOf(store), {
        defaultOwnerId: OWNER.id,
        defaultOwnerEmail: OWNER.email,
        ownerIdByEmail: new Map(),
        orgKey: ORG,
        authoritative: false,
      }),
    apply: (chunk) => applyPlannedAccounts(createOnlyPlan(chunk), writer),
  });
}

const blankAccount = { vatId: null, country: null, industry: null, contactName: null, contactEmail: null, contactPhone: null };

test('manual: the form row goes through the import validator (VAT normalized, bad country refused)', () => {
  const table = manualAccountTable({ name: ' Acme ', vatId: 'de 123.456.789', stage: 'LEAD_NEW', contactEmail: 'Ada@Acme.example' });
  assert.deepEqual(table.header, ['name', 'vat_id', 'stage', 'contact_email']);
  const validate = makeMarketingValidator({ stageKeys: STAGES });
  const ok = validate(table.rows[0], table.header);
  assert.equal(ok.ok, true);
  assert.equal(ok.value.name, 'Acme');
  assert.equal(ok.value.vatId, 'DE123456789');
  assert.equal(ok.value.contactEmail, 'ada@acme.example');
  const bad = manualAccountTable({ name: 'Acme', country: 'Germany' });
  assert.equal(validate(bad.rows[0], bad.header).ok, false);
});

test('manual: a new account creates the account, a stand-in lead and one funnel record', async () => {
  const store = memoryStore();
  const report = await runManual(
    { name: 'Acme GmbH', country: 'DE', stage: 'LEAD_NEW', contactName: 'Ada', contactEmail: 'ada@acme.example' },
    store,
  );
  assert.equal(report.rows[0].status, 'CREATE');
  assert.equal(store.accounts.length, 1);
  assert.equal(store.accounts[0].contactEmail, 'ada@acme.example');
  assert.equal(store.leads[0].email, standIn('ada@acme.example'));
  assert.equal(store.relations.length, 1);
  assert.equal(store.relations[0].pipelineStatus, 'LEAD_NEW');
  assert.equal(store.relations[0].mentorId, OWNER.id);
});

test('manual: the same VAT a second time writes nothing and names the existing account', async () => {
  const store = memoryStore({ accounts: [{ ...blankAccount, id: 'co-acme', name: 'Acme GmbH', vatId: 'DE123456789', country: 'DE' }] });
  const report = await runManual(
    { name: 'ACME Handels GmbH', vatId: 'DE 123 456 789', stage: 'LEAD_NEW', contactEmail: 'bob@acme.example' },
    store,
  );
  // An UPDATE in the import; in create-only it is the "already exists" answer.
  assert.equal(report.rows[0].status, 'UPDATE');
  assert.equal(report.rows[0].targetId, 'co-acme');
  assert.equal(store.accounts.length, 1);
  assert.equal(store.accounts[0].name, 'Acme GmbH', 'the existing account was not renamed');
  assert.equal(store.leads.length, 0);
  assert.equal(store.relations.length, 0);
});

test('manual: name + country matches when there is no VAT', async () => {
  const store = memoryStore({ accounts: [{ ...blankAccount, id: 'co-n', name: 'Nordlicht Handel', country: 'DE' }] });
  const report = await runManual({ name: 'nordlicht handel', country: 'de', stage: 'LEAD_NEW', contactEmail: 'x@n.example' }, store);
  assert.ok(['UPDATE', 'UNCHANGED'].includes(report.rows[0].status));
  assert.equal(report.rows[0].targetId, 'co-n');
  assert.equal(store.accounts.length, 1);
});

test('manual: a contact already on the funnel is not re-pointed at a new account', async () => {
  const store = memoryStore({
    accounts: [{ ...blankAccount, id: 'co-old', name: 'Old Co', country: 'DE' }],
    leads: [{ id: 'lead-1', email: standIn('ada@acme.example'), fullName: 'Ada', phone: null, city: null, country: null, preferredLanguage: null, referralSource: null, companyId: 'co-old' }],
    relations: [{ id: 'rel-1', mentorId: OWNER.id, menteeId: 'lead-1', companyId: 'co-old', pipelineStatus: 'LEAD_CONTACTED', status: 'ACTIVE' }],
  });
  const report = await runManual({ name: 'Brand New AG', country: 'AT', stage: 'LEAD_NEW', contactEmail: 'ada@acme.example' }, store);
  assert.equal(report.rows[0].status, 'SKIP');
  assert.equal(report.rows[0].reason, CONTACT_IN_FUNNEL);
  assert.equal(store.accounts.length, 1);
  assert.equal(store.relations[0].companyId, 'co-old');
  assert.equal(store.relations[0].pipelineStatus, 'LEAD_CONTACTED');
});

// ── Staff is never a lead (#2562 review) ─────────────────────────────────────
//
// The lead lookup matches a contact address against the org's Users. Before the
// fix it matched EVERY role, so an admin typing their own address as the
// contact was "the lead": their profile was filled in, their companyId moved to
// the new account and a relation with mentorId === menteeId was created. The
// store now selects MENTEE only and the diff drops any other role it is handed;
// the form additionally refuses such an address up front (CONTACT_IS_USER).

const { isLeadRole, CONTACT_IS_USER } = await import('../../src/lib/marketingImport.ts');

const ownerAsUser = {
  id: OWNER.id,
  email: OWNER.email,
  fullName: 'Owner',
  phone: null,
  city: null,
  country: null,
  preferredLanguage: null,
  referralSource: null,
  companyId: null,
  role: 'ADMIN',
};

test('only a MENTEE may stand in as a lead', () => {
  assert.equal(isLeadRole('MENTEE'), true);
  assert.equal(isLeadRole(undefined), true, 'a snapshot without the field still reads');
  for (const role of ['ADMIN', 'MENTOR', 'COMPANY', null]) assert.equal(isLeadRole(role), false, String(role));
  assert.equal(CONTACT_IS_USER, 'contact_is_user');
});

test('manual: the owner typing their own address as the contact never becomes the lead', async () => {
  const store = memoryStore({ leads: [ownerAsUser] });
  const report = await runManual(
    { name: 'Self Typed GmbH', country: 'DE', stage: 'LEAD_NEW', contactName: 'Me', contactEmail: OWNER.email },
    store,
  );
  assert.equal(report.rows[0].status, 'CREATE');
  assert.equal(report.rows[0].value.funnel.leadId, null, 'the staff user was not matched as the lead');
  const owner = store.leads.find((l) => l.id === OWNER.id);
  assert.deepEqual(owner, ownerAsUser, 'the staff user was not touched');
  assert.equal(store.relations.length, 1);
  assert.notEqual(store.relations[0].menteeId, OWNER.id, 'no relation with mentorId === menteeId');
  assert.equal(store.leads.find((l) => l.id === store.relations[0].menteeId).email, standIn(OWNER.email));
});

test('import: a staff address in the file gets a stand-in lead, never the staff user', async () => {
  const colleague = { ...ownerAsUser, id: 'mentor-2', email: 'colleague@example.com', role: 'MENTOR' };
  const store = memoryStore({ leads: [colleague] });
  const text = `${HEADER}\nColleague Co,,DE,,,,,,LEAD_NEW,,,,,,Col,colleague@example.com,+49 30 1`;
  const report = await runFile(text, store, { apply: true });
  assert.equal(report.rows[0].status, 'CREATE');
  assert.deepEqual(store.leads.find((l) => l.id === 'mentor-2'), colleague);
  assert.notEqual(store.relations[0].menteeId, 'mentor-2');
});

// ── external_id and the funnel-record dates (#2554) ─────────────────────────
//
// The import used to leave `Company.externalId` empty (so the usage feed could
// match nothing it created), give every imported TRIAL_ACTIVE record a window
// counted from the import day, and date every record's `startDate` — which the
// cohort and aging reports read — to the day of the import.

const { selectDueTrialReminders } = await import('../../src/lib/trialReminderRule.ts');

const TRIAL_STAGES = [...STAGES, 'TRIAL_ACTIVE', 'TRIAL_EXPIRED'];
const DATED_HEADER = `${HEADER},external_id,trial_started_at,trial_ends_at,customer_since`;
const D_NOW = new Date('2026-05-04T09:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

/** One CSV line under DATED_HEADER from the fields that matter here. */
function datedRow(f) {
  return [
    f.name, '', f.country ?? 'DE', '', f.vat ?? '', '', '', '', f.stage ?? '', '', '', '', '', '',
    f.contactName ?? '', f.contactEmail ?? '', '',
    f.ext ?? '', f.trialStart ?? '', f.trialEnd ?? '', f.since ?? '',
  ].join(',');
}
const datedFile = (...rows) => `${DATED_HEADER}\n${rows.map(datedRow).join('\n')}\n`;
const account = (over) => ({
  id: 'co-a', name: 'Alpha GmbH', vatId: null, country: 'DE', industry: null,
  contactName: null, contactEmail: null, contactPhone: null, externalId: null, ...over,
});

test('dates: only ISO dates are accepted, and a trial cannot end before it starts', () => {
  assert.equal(parseImportDate('2026-05-04').toISOString(), '2026-05-04T00:00:00.000Z');
  assert.equal(parseImportDate('2026-05-04T10:30:00Z').toISOString(), '2026-05-04T10:30:00.000Z');
  assert.equal(parseImportDate('2026-05-04T12:30+02:00').toISOString(), '2026-05-04T10:30:00.000Z');
  for (const bad of ['04.05.2026', '2026-02-30', '2026-05-04T10:30', '2026-13-01', 'yesterday', '2026-05-04T25:00Z']) {
    assert.equal(parseImportDate(bad), null, bad);
  }
  const validate = makeMarketingValidator({ stageKeys: TRIAL_STAGES });
  const table = parseDelimited(datedFile(
    { name: 'A', trialEnd: '04.05.2026' },
    { name: 'B', trialStart: '2026-05-10', trialEnd: '2026-05-01' },
    { name: 'C', since: '2026-02-30' },
  ));
  const [a, b, c] = table.rows.map((r) => validate(r, table.header));
  assert.equal(a.ok, false);
  assert.match(a.reason, /trial_ends_at must be an ISO date/);
  assert.match(b.reason, /trial_ends_at is before trial_started_at/);
  assert.match(c.reason, /customer_since must be an ISO date/);
});

test('dates and external_id: German/Turkish header aliases are the same columns', () => {
  const validate = makeMarketingValidator({ stageKeys: TRIAL_STAGES });
  const table = parseDelimited(
    'Firma;Land;SaleVali ID;Testbeginn;Testende;Kunde seit\nAlpha GmbH;DE;64f0c0ffee;2026-04-01;2026-05-01;2025-11-15\n',
  );
  const row = validate(table.rows[0], table.header);
  assert.equal(row.ok, true);
  assert.equal(row.value.externalId, '64f0c0ffee');
  assert.equal(row.value.trialStartedAt.toISOString(), '2026-04-01T00:00:00.000Z');
  assert.equal(row.value.trialEndsAt.toISOString(), '2026-05-01T00:00:00.000Z');
  assert.equal(row.value.customerSince.toISOString(), '2025-11-15T00:00:00.000Z');
  assert.equal(row.key, 'ext:64f0c0ffee', 'the external id is the first half of the match key');
  const tr = parseDelimited('firma adi,ulke,harici id,deneme bitiş,müşteri tarihi\nBeta,TR,X1,2026-06-01,2024-01-01\n');
  const trRow = validate(tr.rows[0], tr.header);
  assert.equal(trRow.value.externalId, 'X1');
  assert.equal(trRow.value.trialEndsAt.toISOString(), '2026-06-01T00:00:00.000Z');
  assert.equal(trRow.value.customerSince.toISOString(), '2024-01-01T00:00:00.000Z');
});

test('the file writes external_id and the funnel-record dates; the second apply is UNCHANGED', async () => {
  const store = memoryStore({ now: D_NOW });
  const text = datedFile({
    name: 'Alpha GmbH', stage: 'TRIAL_ACTIVE', contactEmail: 'a@alpha.example', ext: '64f0c0ffee00112233445566',
    trialStart: '2026-04-20', trialEnd: '2026-05-20', since: '2026-04-20',
  });
  const dry = await runFile(text, store, { stageKeys: TRIAL_STAGES });
  const first = await runFile(text, store, { apply: true, stageKeys: TRIAL_STAGES });
  assert.deepEqual(dry.rows.map((r) => [r.status, r.reason]), first.rows.map((r) => [r.status, r.reason]));
  assert.equal(first.counts.CREATE, 1);
  assert.equal(first.rows[0].reason, undefined, 'explicit dates: no default-window warning');
  assert.equal(store.accounts[0].externalId, '64f0c0ffee00112233445566');
  const relation = store.relations[0];
  assert.equal(relation.trialStartedAt.toISOString(), '2026-04-20T00:00:00.000Z');
  assert.equal(relation.trialEndsAt.toISOString(), '2026-05-20T00:00:00.000Z', 'the file date wins over the stamp');
  assert.equal(relation.startDate.toISOString(), '2026-04-20T00:00:00.000Z', 'customer_since is the record start');

  const second = await runFile(text, store, { apply: true, stageKeys: TRIAL_STAGES });
  assert.equal(second.counts.UNCHANGED, 1);
  assert.equal(second.counts.UPDATE, 0);
  assert.equal(store.relations.length, 1);
});

test('an imported trial is in the reminder window (the file date, and the default window)', async () => {
  const store = memoryStore({ now: D_NOW, trialLengthDays: 7 });
  const text = datedFile(
    { name: 'Explicit GmbH', stage: 'TRIAL_ACTIVE', contactEmail: 'e@explicit.example', trialEnd: '2026-05-07' },
    { name: 'Default GmbH', stage: 'TRIAL_ACTIVE', contactEmail: 'd@default.example' },
  );
  await runFile(text, store, { apply: true, stageKeys: TRIAL_STAGES });
  const due = selectDueTrialReminders(
    store.relations.map((r) => ({ id: r.id, trialEndsAt: r.trialEndsAt, sentThresholds: [] })),
    { now: D_NOW },
  );
  const nameOf = (relationId) =>
    store.accounts.find((a) => a.id === store.relations.find((r) => r.id === relationId).companyId).name;
  const byAccount = Object.fromEntries(due.map((d) => [nameOf(d.relationId), d.threshold]));
  assert.deepEqual(byAccount, { 'Explicit GmbH': 3, 'Default GmbH': 7 });
});

test('TRIAL_ACTIVE without trial_ends_at: a row warning and the default window', async () => {
  const store = memoryStore({ now: D_NOW, trialLengthDays: 14 });
  const text = datedFile(
    { name: 'NoDates GmbH', stage: 'TRIAL_ACTIVE', contactEmail: 'n@nodates.example' },
    { name: 'StartOnly GmbH', stage: 'TRIAL_ACTIVE', contactEmail: 's@startonly.example', trialStart: '2026-05-01' },
  );
  const dry = await runFile(text, store, { stageKeys: TRIAL_STAGES });
  assert.match(dry.rows[0].reason, /trial_ends_at is blank: the default trial window applies \(14 days from the import day\)/);
  assert.match(dry.rows[1].reason, /\(14 days from trial_started_at\)/);
  await runFile(text, store, { apply: true, stageKeys: TRIAL_STAGES });
  const [noDates, startOnly] = store.relations;
  assert.equal(noDates.trialStartedAt.getTime(), D_NOW.getTime());
  assert.equal(noDates.trialEndsAt.getTime() - D_NOW.getTime(), 14 * DAY);
  assert.equal(startOnly.trialStartedAt.toISOString(), '2026-05-01T00:00:00.000Z');
  assert.equal(startOnly.trialEndsAt.toISOString(), '2026-05-15T00:00:00.000Z', 'counted from the file start');
  const again = await runFile(text, store, { apply: true, stageKeys: TRIAL_STAGES });
  assert.equal(again.counts.UNCHANGED, 2);
  assert.equal(again.rows[0].reason, undefined, 'no warning once the record has its window');
});

test('an existing window is never overwritten silently — only with --authoritative', async () => {
  const store = memoryStore({ now: D_NOW });
  const first = datedFile({ name: 'Alpha GmbH', stage: 'TRIAL_ACTIVE', contactEmail: 'a@alpha.example', trialEnd: '2026-05-20', since: '2026-01-01' });
  await runFile(first, store, { apply: true, stageKeys: TRIAL_STAGES });
  const changed = datedFile({ name: 'Alpha GmbH', stage: 'TRIAL_ACTIVE', contactEmail: 'a@alpha.example', trialEnd: '2026-06-30', since: '2025-06-01' });

  const gapOnly = await runFile(changed, store, { apply: true, stageKeys: TRIAL_STAGES });
  assert.equal(gapOnly.rows[0].status, 'UNCHANGED');
  assert.match(gapOnly.rows[0].reason, /left alone: funnelRecord\.trialEndsAt, funnelRecord\.startDate/);
  assert.equal(store.relations[0].trialEndsAt.toISOString(), '2026-05-20T00:00:00.000Z');

  const forced = await runFile(changed, store, { apply: true, authoritative: true, stageKeys: TRIAL_STAGES });
  assert.equal(forced.rows[0].status, 'UPDATE');
  assert.deepEqual(forced.rows[0].changed, ['funnelRecord.trialEndsAt', 'funnelRecord.startDate']);
  assert.equal(store.relations[0].trialEndsAt.toISOString(), '2026-06-30T00:00:00.000Z');
  assert.equal(store.relations[0].startDate.toISOString(), '2025-06-01T00:00:00.000Z');
});

test('a gap in a stored window is filled; a legacy TRIAL_ACTIVE record with no end is warned about', async () => {
  const store = memoryStore({
    now: D_NOW,
    accounts: [account({ id: 'co-a', contactEmail: 'a@alpha.example' })],
    leads: [{ id: 'lead-a', email: standIn('a@alpha.example'), fullName: 'A', phone: null, city: null, country: 'DE', preferredLanguage: null, referralSource: null, companyId: 'co-a', role: 'MENTEE' }],
    relations: [{ id: 'rel-a', mentorId: OWNER.id, menteeId: 'lead-a', companyId: 'co-a', pipelineStatus: 'TRIAL_ACTIVE', status: 'ACTIVE', trialStartedAt: null, trialEndsAt: null, startDate: D_NOW }],
  });
  const blank = datedFile({ name: 'Alpha GmbH', stage: 'TRIAL_ACTIVE', contactEmail: 'a@alpha.example' });
  const warned = await runFile(blank, store, { stageKeys: TRIAL_STAGES });
  assert.equal(warned.rows[0].status, 'UNCHANGED');
  assert.match(warned.rows[0].reason, /no trial reminder will be sent until one is set/);

  const filled = await runFile(
    datedFile({ name: 'Alpha GmbH', stage: 'TRIAL_ACTIVE', contactEmail: 'a@alpha.example', trialEnd: '2026-05-30' }),
    store,
    { apply: true, stageKeys: TRIAL_STAGES },
  );
  assert.equal(filled.rows[0].status, 'UPDATE');
  assert.deepEqual(filled.rows[0].changed, ['funnelRecord.trialEndsAt']);
  assert.equal(store.relations[0].trialEndsAt.toISOString(), '2026-05-30T00:00:00.000Z');
});

test('dates on a row that places no funnel record are reported, not dropped silently', async () => {
  const report = await runFile(datedFile({ name: 'Solo GmbH', trialEnd: '2026-06-01', since: '2025-01-01' }), memoryStore(), { stageKeys: TRIAL_STAGES });
  assert.equal(report.rows[0].status, 'CREATE');
  assert.match(report.rows[0].reason, /trial_ends_at, customer_since not stored: the row places no funnel record/);
});

test('external_id beats VAT and name: a renamed merchant with a new VAT is still one account', async () => {
  const store = memoryStore({ accounts: [account({ externalId: 'SV-1' })] });
  const report = await runFile(datedFile({ name: 'Omega AG', country: 'AT', ext: 'sv-1' }), store, { apply: true });
  // Matched although name AND country differ; the file only fills gaps, so it
  // says what it left alone instead of creating a second account.
  assert.equal(report.rows[0].status, 'UNCHANGED');
  assert.match(report.rows[0].reason, /left alone: name, country/);
  assert.equal(report.rows[0].targetId, 'co-a');
  assert.equal(store.accounts.length, 1);
  assert.equal(store.accounts[0].externalId, 'SV-1', 'another spelling of the same key is not a change');
  assert.equal(normalizeExternalIdKey(' SV-1 '), 'sv-1');
});

test('an external id nobody carries yet is filled in on the account the VAT id finds', async () => {
  const store = memoryStore({ accounts: [account({ vatId: 'DE811234567' })] });
  const text = datedFile({ name: 'Alpha GmbH', vat: 'DE811234567', ext: 'SV-9' });
  const first = await runFile(text, store, { apply: true });
  assert.equal(first.rows[0].status, 'UPDATE');
  assert.deepEqual(first.rows[0].changed, ['externalId']);
  assert.equal(store.accounts[0].externalId, 'SV-9');
  const second = await runFile(text, store, { apply: true });
  assert.equal(second.counts.UNCHANGED, 1);
});

test('a conflicting external_id is an ERROR on its row, in the dry run too — never a guess', async () => {
  const store = memoryStore({
    accounts: [
      account({ id: 'co-a', name: 'Alpha GmbH', vatId: 'DE111111111', externalId: 'SV-A' }),
      account({ id: 'co-b', name: 'Beta GmbH', vatId: 'DE222222222', externalId: 'SV-B' }),
      account({ id: 'co-d1', name: 'Dup One', externalId: 'SV-DUP' }),
      account({ id: 'co-d2', name: 'Dup Two', externalId: 'SV-DUP' }),
    ],
  });
  const text = datedFile(
    // the id names A, the VAT id names B
    { name: 'Alpha GmbH', vat: 'DE222222222', ext: 'SV-A' },
    // the VAT finds B, which carries another id
    { name: 'Beta GmbH', vat: 'DE222222222', ext: 'SV-OTHER' },
    // two accounts of the org already carry the id
    { name: 'Dup', ext: 'SV-DUP' },
    // a new id twice in the file, for two different accounts
    { name: 'New One', vat: 'DE333333333', ext: 'SV-NEW' },
    { name: 'New Two', vat: 'DE444444444', ext: 'SV-NEW' },
  );
  for (const apply of [false, true]) {
    const report = await runFile(text, store, { apply });
    const byRow = report.rows.map((r) => [r.row, r.status]);
    assert.deepEqual(byRow, [[1, 'ERROR'], [2, 'ERROR'], [3, 'ERROR'], [4, 'CREATE'], [5, 'ERROR']], `apply=${apply}`);
    assert.match(report.rows[0].reason, /external_id "SV-A" and vat_id name two different accounts/);
    assert.match(report.rows[1].reason, /differs from the external id "SV-B"/);
    assert.match(report.rows[2].reason, /carried by 2 accounts of this organization/);
    assert.match(report.rows[4].reason, /is given to row 4 with a different vat_id/);
  }
  assert.equal(store.accounts.find((a) => a.id === 'co-b').externalId, 'SV-B', 'nothing was re-pointed');
});

test('customer_since reaches back to 1900; a trial date keeps 2000–2100, and the error names the range', () => {
  assert.equal(parseImportDate('1998-03-01', IMPORT_DATE_YEARS.customerSince).toISOString(), '1998-03-01T00:00:00.000Z');
  assert.equal(parseImportDate('1998-03-01T08:00:00Z', IMPORT_DATE_YEARS.customerSince).toISOString(), '1998-03-01T08:00:00.000Z');
  assert.equal(parseImportDate('1998-03-01'), null, 'the default is the trial range');
  assert.equal(parseImportDate('1899-12-31', IMPORT_DATE_YEARS.customerSince), null);
  const validate = makeMarketingValidator({ stageKeys: TRIAL_STAGES });
  const table = parseDelimited(datedFile(
    { name: 'Old Customer GmbH', since: '1998-03-01' },
    { name: 'Old Trial GmbH', trialStart: '1999-01-01' },
  ));
  const [since, trial] = table.rows.map((r) => validate(r, table.header));
  assert.equal(since.ok, true);
  assert.equal(since.value.customerSince.toISOString(), '1998-03-01T00:00:00.000Z');
  assert.equal(trial.ok, false);
  assert.match(trial.reason, /trial_started_at must be an ISO date .* between 2000-01-01 and 2100-12-31, got "1999-01-01"/);
});

test('two rows giving one EXISTING account two different external ids: the second is an ERROR, not a duplicate SKIP', async () => {
  // The cutover case: the account is matched by VAT and carries no id yet.
  const store = memoryStore({ accounts: [account({ vatId: 'DE811234567' })] });
  const text = datedFile(
    { name: 'Alpha GmbH', vat: 'DE811234567', ext: 'X1' },
    { name: 'Alpha GmbH', vat: 'DE811234567', ext: 'Y2' },
    // the same id again, or no id at all, is still the plain duplicate
    { name: 'Alpha GmbH', vat: 'DE811234567', ext: 'x1' },
    { name: 'Alpha GmbH', vat: 'DE811234567' },
  );
  for (const apply of [false, true]) {
    const fresh = memoryStore({ accounts: [account({ vatId: 'DE811234567' })] });
    const report = await runFile(text, apply ? store : fresh, { apply });
    assert.deepEqual(report.rows.map((r) => r.status), ['UPDATE', 'ERROR', 'SKIP', 'SKIP'], `apply=${apply}`);
    assert.match(report.rows[1].reason, /external_id "Y2" differs from the external_id row 1 gives the same account/);
    assert.match(report.rows[2].reason, /duplicate account in file \(first seen at row 1\)/);
  }
  assert.equal(store.accounts[0].externalId, 'X1');
});

test('the trial pair the record ENDS UP with is checked: a gap-filled start after the kept end is an ERROR', async () => {
  const seed = () => ({
    now: D_NOW,
    accounts: [account({ id: 'co-a', contactEmail: 'a@alpha.example' })],
    leads: [{ id: 'lead-a', email: standIn('a@alpha.example'), fullName: 'A', phone: null, city: null, country: 'DE', preferredLanguage: null, referralSource: null, companyId: 'co-a', role: 'MENTEE' }],
    relations: [{ id: 'rel-a', mentorId: OWNER.id, menteeId: 'lead-a', companyId: 'co-a', pipelineStatus: 'TRIAL_ACTIVE', status: 'ACTIVE', trialStartedAt: null, trialEndsAt: new Date('2026-05-10T00:00:00.000Z'), startDate: D_NOW }],
  });
  const text = datedFile({ name: 'Alpha GmbH', stage: 'TRIAL_ACTIVE', contactEmail: 'a@alpha.example', trialStart: '2026-05-20' });
  for (const apply of [false, true]) {
    const store = memoryStore(seed());
    const report = await runFile(text, store, { apply, stageKeys: TRIAL_STAGES });
    assert.equal(report.rows[0].status, 'ERROR', `apply=${apply}`);
    assert.match(report.rows[0].reason, /trial_ends_at would be before trial_started_at \(the record keeps its trial_ends_at/);
    assert.equal(store.relations[0].trialStartedAt, null, 'nothing written');
  }
  // With overwrite and a consistent pair from the file, the same row lands.
  const store = memoryStore(seed());
  const fixed = datedFile({ name: 'Alpha GmbH', stage: 'TRIAL_ACTIVE', contactEmail: 'a@alpha.example', trialStart: '2026-05-20', trialEnd: '2026-06-20' });
  const forced = await runFile(fixed, store, { apply: true, authoritative: true, stageKeys: TRIAL_STAGES });
  assert.equal(forced.rows[0].status, 'UPDATE');
  assert.equal(store.relations[0].trialEndsAt.toISOString(), '2026-06-20T00:00:00.000Z');
});

test('a TRIAL_ACTIVE row whose trial has already ended is warned about in the preview', async () => {
  const store = memoryStore({ now: D_NOW, trialLengthDays: 14 });
  const text = datedFile(
    { name: 'Past GmbH', stage: 'TRIAL_ACTIVE', contactEmail: 'p@past.example', trialEnd: '2026-05-01' },
    { name: 'OldStart GmbH', stage: 'TRIAL_ACTIVE', contactEmail: 'o@oldstart.example', trialStart: '2026-01-01' },
    { name: 'Future GmbH', stage: 'TRIAL_ACTIVE', contactEmail: 'f@future.example', trialEnd: '2026-05-04' },
  );
  const dry = await runFile(text, store, { stageKeys: TRIAL_STAGES });
  assert.match(dry.rows[0].reason, /trial_ends_at is in the past \(2026-05-01\): the record will move to TRIAL_EXPIRED on the next sweep/);
  assert.match(dry.rows[1].reason, /the default trial window is in the past \(2026-01-15\)/);
  assert.equal(dry.rows[2].reason, undefined, 'a trial ending today is not in the past');
});

test('the shipped sample file runs clean, twice (#2554: external ids, dates, one default window)', async () => {
  const { readFileSync } = await import('node:fs');
  const text = readFileSync(new URL('../fixtures/marketing-accounts-sample.csv', import.meta.url), 'utf8');
  const store = memoryStore({ now: D_NOW });
  const first = await runFile(text, store, { apply: true, stageKeys: TRIAL_STAGES });
  assert.equal(first.counts.CREATE, 6);
  assert.equal(first.counts.ERROR, 0);
  assert.match(first.rows[5].reason, /trial_ends_at is blank: the default trial window applies/);
  assert.equal(store.accounts.filter((a) => a.externalId).length, 5);
  const second = await runFile(text, store, { apply: true, stageKeys: TRIAL_STAGES });
  assert.equal(second.counts.UNCHANGED, 6);
});

// ── The cutover numbers (#2555) ──────────────────────────────────────────────

const { marketingImportMetrics } = await import('../../src/lib/marketingImport.ts');

test('cutover numbers: counted off the report, PII-free, and the second run reads "matched / kept"', async () => {
  const { readFileSync } = await import('node:fs');
  const text = readFileSync(new URL('../fixtures/marketing-accounts-sample.csv', import.meta.url), 'utf8');
  const store = memoryStore({ now: D_NOW });
  const first = await runFile(text, store, { apply: true, stageKeys: TRIAL_STAGES });
  assert.deepEqual(marketingImportMetrics(first.rows), {
    accounts: 6,
    matched: 0,
    withExternalId: 5,
    trials: 2,
    trialEnd: { file: 1, kept: 0, default: 1, missing: 0 },
  });
  const second = await runFile(text, store, { apply: true, stageKeys: TRIAL_STAGES });
  assert.deepEqual(marketingImportMetrics(second.rows), {
    accounts: 6,
    matched: 6,
    withExternalId: 5,
    trials: 2,
    // Both records already carry their end now — the file's one agrees with it.
    trialEnd: { file: 0, kept: 2, default: 0, missing: 0 },
  });
  // Every value is a number: nothing from a row can travel in these.
  const flat = JSON.stringify(marketingImportMetrics(second.rows));
  assert.doesNotMatch(flat, /[A-Za-z]{3,}@|GmbH|Kaya/);
});

test('cutover numbers: SKIP and ERROR rows count toward nothing; a trial with no end is "missing"', async () => {
  const store = memoryStore({
    now: D_NOW,
    accounts: [account({ id: 'co-a', contactEmail: 'a@alpha.example', externalId: 'SV-A' })],
    leads: [{ id: 'lead-a', email: standIn('a@alpha.example'), fullName: 'A', phone: null, city: null, country: 'DE', preferredLanguage: null, referralSource: null, companyId: 'co-a', role: 'MENTEE' }],
    relations: [{ id: 'rel-a', mentorId: OWNER.id, menteeId: 'lead-a', companyId: 'co-a', pipelineStatus: 'TRIAL_ACTIVE', status: 'ACTIVE', trialStartedAt: null, trialEndsAt: null, startDate: D_NOW }],
  });
  const report = await runFile(
    datedFile(
      { name: 'Alpha GmbH', stage: 'TRIAL_ACTIVE', contactEmail: 'a@alpha.example', ext: 'SV-A' },
      { name: 'Alpha GmbH', ext: 'SV-A' },
      { name: 'Broken', trialEnd: 'soon' },
    ),
    store,
    { stageKeys: TRIAL_STAGES },
  );
  assert.deepEqual(report.rows.map((r) => r.status), ['UNCHANGED', 'SKIP', 'ERROR']);
  assert.deepEqual(marketingImportMetrics(report.rows), {
    accounts: 1,
    matched: 1,
    withExternalId: 1,
    trials: 1,
    trialEnd: { file: 0, kept: 0, default: 0, missing: 1 },
  });
});
