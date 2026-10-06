// Mid-programme migration rules (#2073) — no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./ts-extensionless-resolve.mjs', import.meta.url);

const R = await import('../../src/lib/migration/migrationRules.ts');
const NOW = new Date('2026-10-06T12:00:00Z');
const STAGES = new Set(['APPLICATION_100', 'INTERVIEW_PENDING_250', 'INTERNSHIP_IN_PROGRESS_450', 'HIRED_660']);

test('columns are found through the mapping, else by name; a missing required field is named', () => {
  const t = R.mappedTable('people', 'E-Mail;Name;Rolle\nada@demo.example.com;Ada;Mentee', { email: 'E-Mail', fullName: 'Name', role: 'Rolle' });
  assert.deepEqual(t.rows[0].values.slice(0, 3), ['ada@demo.example.com', 'Ada', 'Mentee']);
  assert.deepEqual(t.missing, []);
  assert.deepEqual(R.mappedTable('people', 'mail,name\nx@y.de,X').missing, ['email', 'role']);
});

test('people: roles in three languages, lengths, lower-cased keys', () => {
  const row = (values) => ({ row: 1, values });
  assert.deepEqual(R.validatePerson(row(['Ada@Demo.example.com', 'Ada', 'Mentör', '', '', ''])), {
    ok: true, row: 1, key: 'ada@demo.example.com',
    value: { email: 'ada@demo.example.com', fullName: 'Ada', role: 'MENTOR', phone: null, university: null, department: null },
  });
  assert.equal(R.validatePerson(row(['a@b.co', '', 'Praktikant', '', '', ''])).value.role, 'MENTEE');
  assert.match(R.validatePerson(row(['a@b.co', '', 'boss', '', '', ''])).reason, /unknown role/);
  assert.match(R.validatePerson(row(['a@b.co', 'N'.repeat(192), 'mentee', '', '', ''])).reason, /fullName too long/);
});

test('a stage is translated only when someone said how — never defaulted', () => {
  const map = { 'Erstgespräch': 'APPLICATION_100', 'Im Praktikum': 'INTERNSHIP_IN_PROGRESS_450', Typo: 'NOT_A_STAGE' };
  assert.equal(R.translateStage(' im  praktikum ', map, STAGES), 'INTERNSHIP_IN_PROGRESS_450');
  assert.equal(R.translateStage('HIRED_660', map, STAGES), 'HIRED_660'); // an exact key of ours
  assert.equal(R.translateStage('Abgelehnt', map, STAGES), null);
  assert.equal(R.translateStage('Typo', map, STAGES), null);
  assert.deepEqual(R.invalidStageTargets(map, STAGES), ['NOT_A_STAGE']);
});

test('history rows: unmapped, future, X → X and unreadable dates are rejected', () => {
  const h = (values) => R.validateHistory({ row: 3, values }, { Start: 'APPLICATION_100' }, STAGES, NOW);
  assert.match(h(['m@x.de', 'e@x.de', '', 'Somewhere', '2026-01-01']).reason, /unmapped stage "Somewhere"/);
  assert.match(h(['m@x.de', 'e@x.de', '', 'HIRED_660', '2027-01-01']).reason, /future/);
  assert.match(h(['m@x.de', 'e@x.de', 'HIRED_660', 'HIRED_660', '2026-01-01']).reason, /same stage/);
  assert.match(h(['m@x.de', 'e@x.de', '', 'HIRED_660', '03/04/2026']).reason, /unreadable date/);
  const ok = h(['M@x.de', 'e@x.de', '', 'HIRED_660', '01.03.2026']);
  assert.equal(ok.ok, true);
  assert.equal(ok.value.at.toISOString(), '2026-03-01T00:00:00.000Z');
  assert.equal(ok.key, 'm@x.de|e@x.de');
});

test('history is ordered in time, a missing `from` is the previous `to`, and a chain X → X is dropped', () => {
  const v = (row, toStage, at, fromStage = null) => ({ row, value: { pair: 'p', mentorEmail: 'm', menteeEmail: 'e', fromStage, toStage, at: new Date(at) } });
  const { moves, rejected, final } = R.orderHistory(
    [v(1, 'INTERNSHIP_IN_PROGRESS_450', '2026-03-01'), v(2, 'INTERVIEW_PENDING_250', '2026-02-01'), v(3, 'INTERNSHIP_IN_PROGRESS_450', '2026-04-01'), v(4, 'HIRED_660', '2026-05-01')],
    'APPLICATION_100',
  );
  assert.deepEqual(moves.map((m) => [m.row, m.fromStage, m.toStage]), [
    [2, 'APPLICATION_100', 'INTERVIEW_PENDING_250'],
    [1, 'INTERVIEW_PENDING_250', 'INTERNSHIP_IN_PROGRESS_450'],
    [4, 'INTERNSHIP_IN_PROGRESS_450', 'HIRED_660'],
  ]);
  assert.deepEqual(rejected, [{ row: 3, reason: 'from and to are the same stage' }]);
  assert.equal(final, 'HIRED_660'); // the pair stands where its last move took it
  for (const m of moves) assert.notEqual(m.fromStage, m.toStage); // #934
});

test('interactions: types in three languages, required notes, limits', () => {
  const i = (values) => R.validateInteraction({ row: 1, values }, NOW);
  assert.equal(i(['m@x.de', 'e@x.de', '2026-02-01', 'Görüşme', '', 'Kickoff']).value.type, 'Meeting');
  assert.equal(i(['m@x.de', 'e@x.de', '2026-02-01', 'e-mail', 'Hi', 'Sent the plan']).value.type, 'Email');
  assert.match(i(['m@x.de', 'e@x.de', '2026-02-01', 'Lunch', '', 'x']).reason, /unknown type/);
  assert.match(i(['m@x.de', 'e@x.de', '2026-02-01', 'Meeting', '', '']).reason, /notes missing/);
  assert.match(i(['m@x.de', 'e@x.de', '2026-02-01', 'Meeting', '', 'N'.repeat(5001)]).reason, /notes too long/);
});

test('pairs: the same person on both sides, unknown status and a future start are rejected', () => {
  const p = (values) => R.validatePair({ row: 1, values }, NOW);
  assert.match(p(['a@x.de', 'A@x.de', '', '']).reason, /same person/);
  assert.match(p(['a@x.de', 'b@x.de', 'paused', '']).reason, /unknown status/);
  assert.match(p(['a@x.de', 'b@x.de', '', '2030-01-01']).reason, /future/);
  assert.deepEqual(p(['A@x.de', 'b@x.de', 'Abgeschlossen', '']).value, { mentorEmail: 'a@x.de', menteeEmail: 'b@x.de', status: 'COMPLETED', startDate: null });
});
