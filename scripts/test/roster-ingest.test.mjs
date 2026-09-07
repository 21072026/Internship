// Unit tests for the roster ingestion engine (#1965).
//
// Run: npm run test:roster-ingest  (node --test --experimental-strip-types)
//
// WHY THESE ARE UNIT TESTS AND NOT A BROWSER TEST
//   Four of the properties this engine promises are invisible from a browser
//   and invisible to the type system:
//
//     • the DIFF — a row that changed is an update, a row that did not is not
//       written at all, and with an external-ID key an e-mail change is an
//       update rather than a leaver plus a joiner (which #1966 would
//       deprovision);
//     • RESUME AFTER A CRASH MID-BATCH — the checkpoint is contiguous, so a
//       chunk that failed is re-attempted next run instead of being skipped for
//       ever, and a chunk that already committed is not applied twice;
//     • DRY-RUN HONESTY — the preview must be produced by the code that
//       applies, so the same file must plan identically in both modes;
//     • IDEMPOTENCY — the same file applied twice changes nothing the second
//       time.
//
//   Every one of those is a property of a sequence of runs against a store, and
//   all four typecheck perfectly while being wrong. The store and the writer are
//   therefore ports, and this file is the in-memory world behind them: no
//   database, no SFTP server, ~1s.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// `src/lib/rosterIngest.ts` imports the shared engine as `./importPreview` —
// the specifier the app's bundler resolves and Node's ESM resolver does not.
// The hook below closes that one gap for the test runner; it has to be
// installed before the modules load, which is why these imports are dynamic
// (a static import would be hoisted above the register() call).
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const {
  MAX_FEED_BYTES,
  applyPlannedRows,
  assertHostKeyFingerprint,
  diffRoster,
  fetchFeedFile,
  hashFeedBytes,
  ingestRoster,
  normalizeHostKeyFingerprint,
  parseRoster,
  previewWriter,
  validateRosterRow,
} = await import('../../src/lib/rosterIngest.ts');
const { parseDelimited, sniffDelimiter } = await import('../../src/lib/importPreview.ts');
const { planFieldUpdates } = await import('../../src/lib/externalSyncPolicy.ts');

const ORG_A = 'org-a';
const ORG_B = 'org-b';

const feedFor = (overrides = {}) => ({
  id: 'feed-1',
  orgId: ORG_A,
  name: 'HR export',
  transport: 'HTTPS',
  url: 'https://hr.example.com/roster.csv',
  keyField: 'EMAIL',
  columnMap: {
    email: 'email',
    externalId: 'personnel_no',
    fullName: 'name',
    phone: 'phone',
    university: 'university',
    department: 'department',
  },
  authoritative: false,
  ...overrides,
});

// ── The in-memory world behind the two ports ─────────────────────────────────
// It mimics the three things the Prisma store does that matter to these
// properties: the chunk is a transaction (a throw rolls the whole chunk back),
// the checkpoint is written with the chunk, and `email` is globally unique
// (which is what stops one tenant's feed from touching another tenant's row).
function createWorld(initialUsers = []) {
  const users = initialUsers.map((u) => ({ ...u }));
  const runs = [];
  const rowResults = new Map(); // runId -> Map<rowNumber, result>
  const log = []; // every attempted write, in order
  let seq = 0;
  const world = {
    users,
    runs,
    log,
    /** chunkIndex → true: that chunk's transaction dies (nothing it did commits). */
    failChunk: () => false,
    /** key → message: that ONE row throws; the rest of the chunk still applies. */
    failRow: () => null,
  };

  const writerFor = (feed) => ({
    async create(row) {
      const message = world.failRow(row.key);
      if (message) throw new Error(message);
      const email = row.value.changes.email;
      if (users.some((u) => u.email === email)) {
        // What MySQL's unique index does. A feed for org A that names an org B
        // person must fail loudly, never silently adopt or overwrite them.
        throw new Error('Unique constraint failed on the fields: (`email`)');
      }
      const user = {
        id: `u${++seq}`,
        orgId: feed.orgId,
        email,
        externalId: row.value.changes.externalId ?? null,
        fullName: row.value.changes.fullName ?? email,
        phone: row.value.changes.phone ?? null,
        university: row.value.changes.university ?? null,
        department: row.value.changes.department ?? null,
      };
      users.push(user);
      log.push({ op: 'create', key: row.key, orgId: feed.orgId });
      return user.id;
    },
    async update(row) {
      const message = world.failRow(row.key);
      if (message) throw new Error(message);
      // The real writer scopes the update by (id, orgId) — this is that guard.
      const user = users.find((u) => u.id === row.targetId && u.orgId === feed.orgId);
      if (!user) throw new Error('The row to update is not in this feed’s organisation');
      Object.assign(user, row.value.changes);
      log.push({ op: 'update', key: row.key, orgId: feed.orgId });
      return user.id;
    },
  });

  const storeFor = (feed) => ({
    async lastSuccessfulRun(feedId) {
      return (
        [...runs]
          .reverse()
          .find((r) => r.feedId === feedId && !r.dryRun && r.status === 'SUCCEEDED') ?? null
      );
    },
    async findRun(feedId, fileHash, dryRun) {
      return runs.find((r) => r.feedId === feedId && r.fileHash === fileHash && r.dryRun === dryRun) ?? null;
    },
    async startRun(input) {
      const run = {
        id: `run${runs.length + 1}`,
        feedId: input.feedId,
        orgId: input.orgId,
        fileHash: input.fileHash,
        dryRun: input.dryRun,
        status: 'RUNNING',
        nextChunkIndex: 0,
        startedAt: new Date(),
        rowCount: input.rowCount,
      };
      runs.push(run);
      return run;
    },
    async reopenRun(run) {
      const stored = runs.find((r) => r.id === run.id);
      stored.status = 'RUNNING';
      return stored;
    },
    async recordNoopRun(input) {
      const existing = runs.find(
        (r) => r.feedId === input.feedId && r.fileHash === input.fileHash && !r.dryRun,
      );
      if (existing) return existing;
      const run = {
        id: `run${runs.length + 1}`,
        feedId: input.feedId,
        orgId: input.orgId,
        fileHash: input.fileHash,
        dryRun: false,
        status: 'NOOP',
        nextChunkIndex: 0,
        startedAt: new Date(),
      };
      runs.push(run);
      return run;
    },
    async recordedRows(runId) {
      return [...(rowResults.get(runId)?.values() ?? [])];
    },
    async commitChunk({ run, chunkIndex, rows }) {
      // One transaction: snapshot, apply, and on any throw restore everything
      // the chunk touched — including the checkpoint.
      const snapshotUsers = users.map((u) => ({ ...u }));
      const snapshotRows = new Map([...(rowResults.get(run.id) ?? new Map())]);
      const snapshotLog = log.length;
      const stored = runs.find((r) => r.id === run.id);
      const snapshotCheckpoint = stored.nextChunkIndex;
      try {
        if (world.failChunk(chunkIndex)) throw new Error(`chunk ${chunkIndex} died`);
        const writer = run.dryRun ? previewWriter : writerFor(feed);
        const results = await applyPlannedRows(rows, writer);
        const persisted = rowResults.get(run.id) ?? new Map();
        for (const result of results) {
          persisted.set(result.row, {
            row: result.row,
            key: result.key,
            status: result.status,
            reason: result.reason,
            targetId: result.targetId ?? null,
          });
        }
        rowResults.set(run.id, persisted);
        // Contiguous: never advances past a chunk that failed.
        if (stored.nextChunkIndex === chunkIndex) stored.nextChunkIndex = chunkIndex + 1;
        return results;
      } catch (error) {
        users.length = 0;
        users.push(...snapshotUsers);
        rowResults.set(run.id, snapshotRows);
        log.length = snapshotLog;
        stored.nextChunkIndex = snapshotCheckpoint;
        throw error;
      }
    },
    async finishRun({ run, status, counts, absent }) {
      const stored = runs.find((r) => r.id === run.id);
      stored.status = status;
      stored.counts = counts;
      stored.absent = absent;
    },
  });

  world.run = (feed, text, options = {}) =>
    ingestRoster(
      feed,
      {
        store: storeFor(feed),
        // Exactly what the Prisma loader does: this feed's org only.
        loadTarget: async (f) =>
          users
            .filter((u) => u.orgId === f.orgId)
            .map((u) => ({ ...u })),
        fetchFile: async () => ({
          text,
          fileHash: hashFeedBytes(text),
          bytes: Buffer.byteLength(text),
          source: 'https://hr.example.com/roster.csv',
        }),
      },
      options,
    );

  world.userByEmail = (email) => users.find((u) => u.email === email);
  world.statuses = (report) => report.rows.map((r) => `${r.row}:${r.status}`);
  return world;
}

const rowsOf = (feed, text) => {
  const table = parseRoster(text, feed);
  const valid = [];
  for (const row of table.rows) {
    const result = validateRosterRow(feed, row, table.header);
    if (result.ok) valid.push({ row: result.row, key: result.key, value: result.value });
  }
  return valid;
};

// ── The parser fixtures ──────────────────────────────────────────────────────

test('a quoted embedded newline is one field, not two rows', () => {
  const csv = 'name,email,department\n"Ada\nLovelace",ada@example.com,"R&D, core"\n';
  const table = parseDelimited(csv);
  assert.equal(table.rows.length, 1, 'the newline inside the quotes is not a row break');
  assert.deepEqual(table.rows[0].values, ['Ada\nLovelace', 'ada@example.com', 'R&D, core']);
});

test('CRLF line endings and a trailing newline produce no phantom row', () => {
  const table = parseDelimited('name,email\r\nAda,ada@example.com\r\nBob,bob@example.com\r\n');
  assert.equal(table.rows.length, 2);
  assert.deepEqual(table.rows[1].values, ['Bob', 'bob@example.com']);
});

test('a UTF-8 BOM does not become part of the first header name', () => {
  const table = parseDelimited('﻿email,name\nada@example.com,Ada\n');
  assert.equal(table.header[0], 'email', 'the BOM would make this "\\uFEFFemail" and break the map');
  assert.equal(table.rows.length, 1);
});

test('a semicolon-delimited German Excel export is read as columns', () => {
  const csv = 'name;email;department\nAda Lovelace;ada@example.com;Forschung & Entwicklung\n';
  assert.equal(sniffDelimiter(csv), ';');
  const table = parseDelimited(csv);
  assert.deepEqual(table.header, ['name', 'email', 'department']);
  assert.deepEqual(table.rows[0].values, ['Ada Lovelace', 'ada@example.com', 'Forschung & Entwicklung']);
});

test('all four quirks in one file, plus an escaped quote', () => {
  const csv =
    '﻿name;email;note\r\n' +
    '"Ada ""The Countess"" Lovelace";ada@example.com;"line 1\r\nline 2"\r\n' +
    'Bob;bob@example.com;plain\r\n';
  const table = parseDelimited(csv);
  assert.equal(table.delimiter, ';');
  assert.equal(table.header[0], 'name');
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[0].values[0], 'Ada "The Countess" Lovelace');
  assert.equal(table.rows[0].values[2], 'line 1\nline 2', 'the newline survives, the CR does not');
  assert.equal(table.rows[1].values[1], 'bob@example.com');
});

test('a quoted field keeps its whitespace and an unquoted one is trimmed', () => {
  const table = parseDelimited('a,b\n  x  ,"  y  "\n');
  assert.deepEqual(table.rows[0].values, ['x', '  y  ']);
});

// ── Validation ───────────────────────────────────────────────────────────────

test('a row with no usable email is an ERROR, not a guess', () => {
  const feed = feedFor();
  const table = parseRoster('name,email\nAda,not-an-email\n', feed);
  const result = validateRosterRow(feed, table.rows[0], table.header);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'ERROR');
  assert.equal(result.reason, 'invalid email');
});

test('an external-ID feed rejects a row that has no external id', () => {
  const feed = feedFor({ keyField: 'EXTERNAL_ID' });
  const table = parseRoster('name,email,personnel_no\nAda,ada@example.com,\n', feed);
  const result = validateRosterRow(feed, table.rows[0], table.header);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing external id');
});

// ── The diff ─────────────────────────────────────────────────────────────────

const CURRENT = [
  { id: 'u1', email: 'ada@example.com', fullName: 'Ada Lovelace', phone: '+900000', university: null, department: 'R&D', externalId: 'P-1' },
  { id: 'u2', email: 'bob@example.com', fullName: 'Bob', phone: null, university: null, department: null, externalId: 'P-2' },
];

test('new, changed, unchanged and absent are four different answers', () => {
  const feed = feedFor({ authoritative: true });
  const csv =
    'name,email,department\n' +
    'Ada Lovelace,ada@example.com,R&D\n' + // identical → UNCHANGED
    'Bob,bob@example.com,Sales\n' + // department appears → UPDATE
    'Cleo,cleo@example.com,Ops\n'; // new person → CREATE
  const diff = diffRoster(feed, rowsOf(feed, csv), CURRENT);

  assert.deepEqual(
    diff.plan.map((p) => `${p.row}:${p.status}`),
    ['1:UNCHANGED', '2:UPDATE', '3:CREATE'],
  );
  assert.deepEqual(diff.plan[1].changed, ['department']);
  assert.deepEqual(diff.absent, [], 'both existing people were named by the feed');
});

test('someone the feed no longer mentions is reported absent, never acted on', () => {
  const feed = feedFor();
  const diff = diffRoster(feed, rowsOf(feed, 'name,email\nAda,ada@example.com\n'), CURRENT);
  assert.deepEqual(diff.absent, ['bob@example.com']);
  assert.equal(diff.absentRows[0].id, 'u2');
  assert.ok(
    diff.plan.every((p) => p.status !== 'UPDATE' || p.key !== 'bob@example.com'),
    'absence produces no write here — acting on it is #1966',
  );
});

test('with EMAIL as the key an address change is a leaver plus a joiner', () => {
  const feed = feedFor();
  const csv = 'name,email\nAda Lovelace,ada.lovelace@example.com\nBob,bob@example.com\n';
  const diff = diffRoster(feed, rowsOf(feed, csv), CURRENT);
  assert.equal(diff.plan[0].status, 'CREATE', 'the renamed mailbox looks like a new person');
  assert.deepEqual(diff.absent, ['ada@example.com'], 'and the old one looks like a leaver');
});

test('with EXTERNAL_ID as the key the same change is one update', () => {
  const feed = feedFor({ keyField: 'EXTERNAL_ID', authoritative: true });
  const csv =
    'name,email,personnel_no\n' +
    'Ada Lovelace,ada.lovelace@example.com,P-1\n' +
    'Bob,bob@example.com,P-2\n';
  const diff = diffRoster(feed, rowsOf(feed, csv), CURRENT);
  assert.equal(diff.plan[0].status, 'UPDATE');
  assert.deepEqual(diff.plan[0].changed, ['email']);
  assert.equal(diff.plan[0].targetId, 'u1');
  assert.deepEqual(diff.absent, [], 'nobody left');
});

test('an external-ID feed adopts people who predate it by matching their email once', () => {
  const feed = feedFor({ keyField: 'EXTERNAL_ID', authoritative: true });
  const current = [{ id: 'u9', email: 'dee@example.com', fullName: 'Dee', externalId: null }];
  const diff = diffRoster(
    feed,
    rowsOf(feed, 'name,email,personnel_no\nDee,dee@example.com,P-9\n'),
    current,
  );
  assert.equal(diff.plan[0].status, 'UPDATE');
  assert.equal(diff.plan[0].targetId, 'u9');
  assert.deepEqual(diff.plan[0].changed, ['externalId']);
  assert.deepEqual(diff.absent, []);
});

test('the same person twice in one file is applied once and reported once', () => {
  const feed = feedFor();
  const csv = 'name,email\nAda,ada@example.com\nAda again,ada@example.com\n';
  const diff = diffRoster(feed, rowsOf(feed, csv), CURRENT);
  assert.equal(diff.plan[1].status, 'SKIP');
  assert.equal(diff.plan[1].reason, 'duplicate key in feed');
});

test('a non-authoritative feed fills a gap but never overwrites what a human typed', () => {
  const feed = feedFor({ authoritative: false });
  const csv = 'name,email,phone,university\nAda Lovelace,ada@example.com,+999999,Cambridge\n';
  const diff = diffRoster(feed, rowsOf(feed, csv), CURRENT);
  assert.equal(diff.plan[0].status, 'UPDATE');
  assert.deepEqual(diff.plan[0].changed, ['university'], 'the empty field is filled');
  assert.deepEqual(diff.plan[0].value.withheld, ['phone'], 'the typed one is left alone');
});

test('the same feed marked authoritative does overwrite it', () => {
  const feed = feedFor({ authoritative: true });
  const csv = 'name,email,phone\nAda Lovelace,ada@example.com,+999999\n';
  const diff = diffRoster(feed, rowsOf(feed, csv), CURRENT);
  assert.deepEqual(diff.plan[0].changed, ['phone']);
});

test('an empty column is no opinion — it never blanks a stored value', () => {
  const plan = planFieldUpdates(
    { fullName: 'Ada', phone: '+900000' },
    { fullName: '', phone: '   ' },
    { authoritative: true },
  );
  assert.deepEqual(plan.changed, []);
  assert.deepEqual(plan.changes, {});
});

// ── Dry run, apply, idempotency ──────────────────────────────────────────────

const CSV_THREE =
  'name,email,department\n' +
  'Ada Lovelace,ada@example.com,R&D\n' +
  'Bob,bob@example.com,Sales\n' +
  'Cleo,cleo@example.com,Ops\n';

const seedUsers = () => [
  { id: 'u1', orgId: ORG_A, email: 'ada@example.com', fullName: 'Ada Lovelace', phone: null, university: null, department: 'R&D', externalId: null },
  { id: 'u2', orgId: ORG_A, email: 'bob@example.com', fullName: 'Bob', phone: null, university: null, department: null, externalId: null },
];

test('the dry run writes nothing and plans exactly what the real run then does', async () => {
  const feed = feedFor({ authoritative: true });

  const preview = createWorld(seedUsers());
  const dry = await preview.run(feed, CSV_THREE, { dryRun: true, chunkSize: 2 });
  assert.equal(dry.outcome, 'APPLIED');
  assert.equal(dry.report.dryRun, true);
  assert.equal(preview.log.length, 0, 'a dry run writes nothing');
  assert.equal(preview.users.length, 2, 'and creates nobody');

  const real = createWorld(seedUsers());
  const applied = await real.run(feed, CSV_THREE, { chunkSize: 2 });
  assert.deepEqual(
    real.statuses(applied.report),
    preview.statuses(dry.report),
    'the preview is produced by the code that applies — the plans cannot differ',
  );
  assert.deepEqual(real.statuses(applied.report), ['1:UNCHANGED', '2:UPDATE', '3:CREATE']);
  assert.equal(real.users.length, 3);
  assert.equal(real.userByEmail('cleo@example.com').department, 'Ops');
  assert.deepEqual(
    real.log.map((entry) => entry.op),
    ['update', 'create'],
    'the unchanged row is not written at all',
  );
});

test('applying the same file twice is a no-op the second time', async () => {
  const feed = feedFor({ authoritative: true });
  const world = createWorld(seedUsers());

  const first = await world.run(feed, CSV_THREE);
  assert.equal(first.outcome, 'APPLIED');
  const writesAfterFirst = world.log.length;

  const second = await world.run(feed, CSV_THREE);
  assert.equal(second.outcome, 'NOOP_UNCHANGED_FILE');
  assert.equal(second.report, null);
  assert.equal(world.log.length, writesAfterFirst, 'nothing was written the second time');
  assert.equal(world.users.length, 3, 'and nobody was created twice');
});

test('a changed file applies only what changed', async () => {
  const feed = feedFor({ authoritative: true });
  const world = createWorld(seedUsers());
  await world.run(feed, CSV_THREE);
  const writesAfterFirst = world.log.length;

  const grown = CSV_THREE + 'Dee,dee@example.com,Legal\n';
  const second = await world.run(feed, grown);
  assert.equal(second.outcome, 'APPLIED');
  assert.equal(second.report.counts.CREATE, 1);
  assert.equal(second.report.counts.UNCHANGED, 3, 'the three already-applied rows are untouched');
  assert.equal(world.log.length - writesAfterFirst, 1, 'exactly one write');
});

test('a run of a file that already succeeded is refused as already applied', async () => {
  const feed = feedFor({ authoritative: true });
  const world = createWorld(seedUsers());
  await world.run(feed, CSV_THREE);
  // A different file lands in between, so the "unchanged since last success"
  // shortcut cannot be what catches the re-run.
  await world.run(feed, CSV_THREE + 'Dee,dee@example.com,Legal\n');
  const writes = world.log.length;

  const again = await world.run(feed, CSV_THREE);
  assert.equal(again.outcome, 'ALREADY_APPLIED');
  assert.equal(world.log.length, writes);
});

// ── Errors and resume ────────────────────────────────────────────────────────

test('one row that throws is an ERROR, and the rest of the chunk still applies', async () => {
  const feed = feedFor({ authoritative: true });
  const world = createWorld([]);
  world.failRow = (key) => (key === 'bob@example.com' ? 'boom' : null);

  const result = await world.run(feed, CSV_THREE, { chunkSize: 3 });
  const byKey = Object.fromEntries(result.report.rows.map((r) => [r.key, r.status]));
  assert.equal(byKey['bob@example.com'], 'ERROR');
  assert.equal(byKey['ada@example.com'], 'CREATE');
  assert.equal(byKey['cleo@example.com'], 'CREATE');
  assert.equal(world.users.length, 2, 'the two good rows are written');
  assert.equal(result.run.status, 'FAILED', 'a run with an errored row stays retriable');
});

test('a chunk whose transaction dies leaves nothing behind, and the run continues', async () => {
  const feed = feedFor({ authoritative: true });
  const world = createWorld([]);
  world.failChunk = (index) => index === 0;

  const result = await world.run(feed, CSV_THREE, { chunkSize: 2 });
  const byRow = Object.fromEntries(result.report.rows.map((r) => [r.row, r.status]));
  assert.equal(byRow[1], 'ERROR');
  assert.equal(byRow[2], 'ERROR', 'the whole chunk rolled back — no half-written chunk (#1432)');
  assert.equal(byRow[3], 'CREATE', 'and the next chunk still ran');
  assert.deepEqual(
    world.users.map((u) => u.email),
    ['cleo@example.com'],
  );
});

test('a crash mid-batch resumes from the checkpoint and applies nothing twice', async () => {
  const feed = feedFor({ authoritative: true });
  const csv =
    'name,email\n' +
    ['ada', 'bob', 'cleo', 'dee', 'eve', 'fay'].map((n) => `${n},${n}@example.com`).join('\n') +
    '\n';

  const world = createWorld([]);
  // Chunks 0 and 1 commit; chunk 2 is where the process dies.
  world.failChunk = (index) => index >= 2;
  const crashed = await world.run(feed, csv, { chunkSize: 2 });

  assert.equal(crashed.run.status, 'FAILED');
  const run = world.runs.find((r) => !r.dryRun);
  assert.equal(run.nextChunkIndex, 2, 'the checkpoint is contiguous — frozen at the failed chunk');
  assert.equal(world.users.length, 4, 'the two committed chunks are on disk');
  const writesBefore = world.log.length;

  // "The next run." Same file, same hash: the FAILED run is resumed, not restarted.
  world.failChunk = () => false;
  const resumed = await world.run(feed, csv, { chunkSize: 2, staleRunMs: 0 });

  assert.equal(resumed.outcome, 'APPLIED');
  assert.equal(resumed.resumedFromChunk, 2, 'it started where the crash stopped');
  assert.equal(resumed.report.startedAtChunk, 2);
  assert.equal(world.users.length, 6, 'the remaining people were created');
  assert.equal(world.log.length - writesBefore, 2, 'and only the remaining ones were written');
  assert.equal(
    world.log.filter((entry) => entry.op === 'create').length,
    6,
    'nobody was created twice',
  );
  // The report covers the whole file, including the rows the earlier attempt committed.
  assert.equal(resumed.report.rows.length, 6);
  assert.equal(resumed.report.counts.ERROR, 0);
  assert.equal(resumed.run.status, 'SUCCEEDED');
});

test('a resumed run re-derives the plan, so a re-attempted chunk is UNCHANGED not a duplicate', async () => {
  const feed = feedFor({ authoritative: true });
  const csv = 'name,email\nada,ada@example.com\nbob,bob@example.com\n';
  const world = createWorld([]);
  world.failChunk = (index) => index === 0;
  await world.run(feed, csv, { chunkSize: 1 });
  assert.equal(world.users.length, 1, 'only chunk 1 committed');

  world.failChunk = () => false;
  const resumed = await world.run(feed, csv, { chunkSize: 1, staleRunMs: 0 });
  // The checkpoint froze at 0, so BOTH chunks run again — and the one that had
  // already been applied comes back UNCHANGED rather than creating a second row.
  assert.equal(resumed.resumedFromChunk, 0);
  assert.equal(world.users.length, 2);
  assert.equal(resumed.report.counts.CREATE, 1);
  assert.equal(resumed.report.counts.UNCHANGED, 1);
});

test('a run that is still in progress is left alone', async () => {
  const feed = feedFor({ authoritative: true });
  const world = createWorld([]);
  world.failChunk = () => true;
  await world.run(feed, CSV_THREE, { chunkSize: 1 });
  // Pretend it is still RUNNING (a live worker), started just now.
  const run = world.runs.find((r) => !r.dryRun);
  run.status = 'RUNNING';
  run.startedAt = new Date();

  world.failChunk = () => false;
  const second = await world.run(feed, CSV_THREE, { chunkSize: 1 });
  assert.equal(second.outcome, 'LOCKED', 'two workers on one file is the double-apply we refuse');
  assert.equal(world.users.length, 0);
});

// ── Tenant isolation ─────────────────────────────────────────────────────────

test("a feed for org A cannot write org B's people", async () => {
  const feed = feedFor({ orgId: ORG_A, authoritative: true });
  const world = createWorld([
    { id: 'b1', orgId: ORG_B, email: 'ada@example.com', fullName: 'Ada of org B', phone: '+B', university: null, department: 'B', externalId: null },
  ]);

  // The feed names an address that exists — in the OTHER tenant.
  const result = await world.run(feed, 'name,email,phone\nAda,ada@example.com,+A\n');

  assert.equal(result.report.rows[0].status, 'ERROR', 'org B is invisible, so the row is a CREATE that then fails');
  const other = world.users.find((u) => u.orgId === ORG_B);
  assert.equal(other.fullName, 'Ada of org B', "org B's row is untouched");
  assert.equal(other.phone, '+B');
  assert.equal(world.users.length, 1, 'and nothing was created');
});

test("the writer refuses a target that is not in the feed's org", async () => {
  // Defence in depth: even if a loader ever handed the diff a foreign row, the
  // write is scoped by (id, orgId) and fails rather than crossing the boundary.
  const feed = feedFor({ orgId: ORG_A, authoritative: true });
  const world = createWorld([
    { id: 'b1', orgId: ORG_B, email: 'ada@example.com', fullName: 'Ada of org B', phone: '+B', university: null, department: null, externalId: null },
  ]);
  const leakyDiff = diffRoster(
    feed,
    rowsOf(feed, 'name,email,phone\nAda,ada@example.com,+A\n'),
    world.users.map((u) => ({ ...u })), // a loader that forgot to filter by org
  );
  assert.equal(leakyDiff.plan[0].status, 'UPDATE');

  const store = { commit: null };
  void store;
  const results = await applyPlannedRows(leakyDiff.plan, {
    async create() {
      throw new Error('should not create');
    },
    async update(row) {
      const user = world.users.find((u) => u.id === row.targetId && u.orgId === feed.orgId);
      if (!user) throw new Error('The row to update is not in this feed’s organisation');
      return user.id;
    },
  });
  assert.equal(results[0].status, 'ERROR');
  assert.match(results[0].reason, /organisation/);
  assert.equal(world.users[0].phone, '+B');
});

// ── Transport safety ─────────────────────────────────────────────────────────

test('the file hash is stable and content-addressed', () => {
  assert.equal(hashFeedBytes('a,b\n1,2\n'), hashFeedBytes('a,b\n1,2\n'));
  assert.notEqual(hashFeedBytes('a,b\n1,2\n'), hashFeedBytes('a,b\n1,3\n'));
  assert.match(hashFeedBytes('x'), /^[0-9a-f]{64}$/);
});

test('an SFTP host key must match the pinned fingerprint, however it is written', () => {
  const pinned = 'SHA256:aa:bb:cc:dd';
  assert.equal(normalizeHostKeyFingerprint(pinned), 'aabbccdd');
  assert.doesNotThrow(() => assertHostKeyFingerprint('AA BB CC DD', pinned));
  assert.throws(() => assertHostKeyFingerprint('aa:bb:cc:de', pinned), /does not match/);
  assert.throws(() => assertHostKeyFingerprint('aa:bb:cc:dd', null), /no pinned/);
  assert.throws(() => assertHostKeyFingerprint('aa:bb:cc:dd', '   '), /no pinned/);
});

// A stub `fetch`. The transport is given one on purpose: these assertions are
// about what the code does with an answer, and a test that needed the network
// would be a test nobody trusts.
const answerWith = (body, { status = 200, contentLength } = {}) =>
  async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) =>
        name.toLowerCase() === 'content-length'
          ? (contentLength ?? String(Buffer.byteLength(body)))
          : null,
    },
    arrayBuffer: async () => Buffer.from(body, 'utf8'),
  });

// A literal public address, so the guard needs no DNS round-trip and the test
// stays hermetic.
const PUBLIC_URL = 'https://93.184.216.34/roster.csv';

test('an HTTPS feed is fetched, hashed and stripped of its query string', async () => {
  const csv = 'email\nada@example.com\n';
  const file = await fetchFeedFile(feedFor({ url: `${PUBLIC_URL}?token=secret` }), {
    fetchImpl: answerWith(csv),
  });
  assert.equal(file.text, csv);
  assert.equal(file.fileHash, hashFeedBytes(csv));
  assert.equal(file.bytes, Buffer.byteLength(csv));
  assert.equal(
    file.source,
    'https://93.184.216.34/roster.csv',
    'the run log keeps host and path only — a query string can carry a token',
  );
});

test('a feed URL that points inside the network is refused before anything is fetched', async () => {
  let called = false;
  const spy = async () => {
    called = true;
    throw new Error('should not be reached');
  };
  for (const url of [
    'https://127.0.0.1/roster.csv',
    'https://169.254.169.254/latest/meta-data/', // the cloud metadata service
    'http://93.184.216.34/roster.csv', // plaintext
    'https://localhost/roster.csv',
  ]) {
    await assert.rejects(() => fetchFeedFile(feedFor({ url }), { fetchImpl: spy }), /./, url);
  }
  assert.equal(called, false, 'the SSRF guard runs before the request, not after');
});

test('a feed larger than the cap is refused, by header and by body', async () => {
  const feed = feedFor({ url: PUBLIC_URL });
  await assert.rejects(
    () =>
      fetchFeedFile(feed, {
        fetchImpl: answerWith('email\n', { contentLength: String(MAX_FEED_BYTES + 1) }),
      }),
    /larger than/,
    'the declared length is checked first, so an oversized body is never buffered',
  );
  await assert.rejects(
    () => fetchFeedFile(feed, { fetchImpl: answerWith('x'.repeat(64), { contentLength: '1' }) , maxBytes: 32 }),
    /larger than/,
    'and a lying content-length does not get past the body check',
  );
});

test('a feed that answers 404 is an error, not an empty roster', async () => {
  // The dangerous failure mode: an empty roster means every person in the
  // tenant is "absent", which is what #1966 would act on.
  await assert.rejects(
    () => fetchFeedFile(feedFor({ url: PUBLIC_URL }), { fetchImpl: answerWith('', { status: 404 }) }),
    /answered 404/,
  );
  await assert.rejects(
    () => fetchFeedFile(feedFor({ url: '' }), { fetchImpl: answerWith('') }),
    /no URL configured/,
  );
});

test('an SFTP feed with no pinned host key refuses to connect', async () => {
  await assert.rejects(
    () => fetchFeedFile(feedFor({ transport: 'SFTP', sftpHost: 'sftp.example.com' })),
    /no pinned SFTP host key/,
  );
  // With a pin it still refuses, because the client dependency is a separate
  // change — loudly, and never by falling back to something less safe.
  await assert.rejects(
    () =>
      fetchFeedFile(
        feedFor({ transport: 'SFTP', sftpHost: 'sftp.example.com', sftpHostKeyFingerprint: 'aa:bb' }),
      ),
    /not wired yet/,
  );
});
