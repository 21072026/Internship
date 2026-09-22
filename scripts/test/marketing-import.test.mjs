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
  leadStandInEmail,
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
        // The stand-in, never the merchant's mailbox — mirrors the Prisma writer.
        email: funnel.leadEmail,
        fullName: funnel.leadChanges.fullName ?? funnel.leadEmail,
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
      throw new AlreadyMentoredError(lead.id, active.id);
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
        orgKey: ORG,
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
