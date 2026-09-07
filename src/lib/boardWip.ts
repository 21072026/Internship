// Board work-in-progress limits (#1439). Pure rule, no imports: the admin board
// is a client component, the settings editor is another one, and the unit spec
// runs this without a browser or a database.
//
// WHY THIS FILE EXISTS AT ALL
//   The limit used to be `const WIP_LIMIT = 8` in the board page. Eight was the
//   right number for the pilot cohort — a column holding nine people really was
//   a queue somebody had stopped working. It is not a scale-invariant truth: at
//   308 relations all thirteen columns read `24 / 8`, `23 / 8`, … and an
//   organisation with a thousand candidates gets thirteen amber chips that say
//   nothing about where the work is stuck. A warning that fires everywhere is
//   decoration.
//
// THE SHAPE OF THE ANSWER
//   One number is not enough, and this is the honest reason: a first-contact
//   column is a funnel mouth and is *supposed* to be deep, while "introduction
//   pending" holding forty people means forty candidates are waiting on us. So
//   the limit resolves per stage:
//
//     1. the stage's own `wipLimit` (StageSla.wipLimit), when it has one
//        · a stored 0 means "never warn about this stage"
//     2. otherwise the org-wide `boardWipLimit` setting
//        · 0 there means "no WIP warnings anywhere"
//     3. otherwise DEFAULT_BOARD_WIP_LIMIT, below
//
//   "No warning" is a first-class answer at both levels rather than a missing
//   value: an operator who does not want WIP warnings switches them off instead
//   of picking a number they will learn to ignore.

/**
 * The default org-wide limit, and the reason for it: it is the number this
 * board shipped with (#1439 replaced the hardcoded `WIP_LIMIT = 8`), so an
 * installation that configures nothing sees exactly the board it saw yesterday
 * and nobody's amber chips move because of a deploy. It is a starting point
 * sized for one mentor's working set, NOT a claim about large programmes —
 * which is why it is a setting now, and why the board says so out loud once
 * every column breaches it (see `isWipSaturated`).
 */
export const DEFAULT_BOARD_WIP_LIMIT = 8;

/**
 * How many breaching columns it takes before the board treats its own warnings
 * as noise. Two columns over the limit on a thirteen-stage board is a signal —
 * those two are where the work sits. Three or more, with nothing left below the
 * line, means the limit is simply lower than how this programme runs: there is
 * no emptier column to move anybody into, so the chips have stopped comparing
 * anything.
 */
export const WIP_SATURATION_MIN_COLUMNS = 3;

/** A column as the WIP rule sees it: how many cards, and the limit that applies. */
export interface WipColumn {
  status: string;
  count: number;
  limit: number | null;
}

/**
 * A typed or stored per-stage limit as a number: `null` for "not configured,
 * inherit", `0` for "never warn about this stage", a positive integer for a
 * real limit. Empty and unparseable both read as not configured — clearing the
 * field is how an admin gives a stage back to the org-wide number.
 */
export function parseStageWipLimit(raw: string | number | null | undefined): number | null {
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return null;
  // A negative cannot mean anything but "off", and it must not fall through to
  // the org default: somebody typed a number, they did not clear the field.
  return Math.max(0, Math.floor(n));
}

/**
 * The org-wide default, from the `boardWipLimit` setting string: `null` when
 * the org switched WIP warnings off (0 or negative), otherwise the number.
 *
 * An empty or unparseable row falls back to DEFAULT_BOARD_WIP_LIMIT rather than
 * to "off" — the same contract the retention windows use: a corrupted setting
 * must not silently disable a signal an operator believes is on.
 */
export function resolveOrgWipLimit(raw: string | number | null | undefined): number | null {
  if (raw == null || raw === '') return DEFAULT_BOARD_WIP_LIMIT;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return DEFAULT_BOARD_WIP_LIMIT;
  const floored = Math.floor(n);
  return floored > 0 ? floored : null;
}

/**
 * The limit that applies to one stage: its own override, else the org default.
 *
 * `perStage` holds only the stages an org has configured. A stage with no entry
 * inherits; an entry of 0 is an explicit "never warn here" and wins over the
 * org number, which is what makes a deliberately deep funnel mouth quiet
 * without switching the rest of the board off.
 */
export function resolveWipLimit(
  stageKey: string,
  orgLimit: number | null,
  perStage?: Map<string, number | null> | Record<string, number | null>
): number | null {
  const own = perStage instanceof Map ? perStage.get(stageKey) : perStage?.[stageKey];
  const parsed = parseStageWipLimit(own ?? null);
  if (parsed == null) return orgLimit;
  return parsed > 0 ? parsed : null;
}

/** Is this column over its limit? A column with no limit never is. */
export function isOverWipLimit(col: WipColumn): boolean {
  return col.limit != null && col.count > col.limit;
}

/**
 * True when the warnings have stopped meaning anything: every column that holds
 * anybody AND carries a limit is over it, and there are at least
 * WIP_SATURATION_MIN_COLUMNS of them. The board then shows one line saying the
 * limit is too low for this programme — with a link to change it — instead of a
 * row of amber chips that no longer point anywhere.
 */
export function isWipSaturated(columns: WipColumn[]): boolean {
  const measured = columns.filter((c) => c.count > 0 && c.limit != null);
  if (measured.length < WIP_SATURATION_MIN_COLUMNS) return false;
  return measured.every(isOverWipLimit);
}
