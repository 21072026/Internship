// A board column's background color, so neighbouring stages can never be
// mistaken for one another.
//
// The stage's OWN color comes first (#3661): an admin picks it per stage on
// the pipeline editor, and the template presets carry one (the sales funnel
// does). `boardColumnPaint()` tints the column with it — a light wash of the
// color, a stronger top stripe — as an inline style, because the color is
// data and Tailwind cannot generate a class for it. Only a strict hex is
// accepted (the column is free text in the DB); anything else, and a stage
// with no color at all (the internship defaults), falls back to the
// positional tone below.
//
// Positional tone (#3666): Colors follow the stage's place in the pipeline:
// first blue, then orange, purple, yellow, red, green (and on past six, more
// contrasting hues); the LAST stage is always gray. For the sales funnel that
// reads New lead → blue … Trial expired → red, Won → green, Lost → gray.
//
// Keyed by the stage's position among ALL stages, not among the visible
// columns: hiding empty stages or filtering must not repaint a column.
// Two neighbours always differ — the cycle is longer than one, and the gray
// last stage is not in it.
//
// Only the column surface is tinted; cards stay white, and the header text
// keeps its gray, which holds AA on every -100 tint. A collapsed empty-stage
// strip prints its label at 10px, where gray-500 does NOT hold on a tint —
// MentorBoard uses gray-700 there (#3675). Full class strings, since
// Tailwind only generates classes it can read literally (this folder is in its
// `content` globs). Two utilities are deliberately avoided because globals.css
// repaints them: blue is the org's ACCENT (`html[data-accent] .bg-blue-100`),
// so a magenta-accented org would get a magenta "blue" column and a light one
// in dark mode — sky is used instead; and gray is remapped under html.dark, so
// the last stage is slate.

const CYCLE = [
  'bg-sky-100 border-sky-300 dark:bg-sky-950 dark:border-sky-800',
  'bg-orange-100 border-orange-300 dark:bg-orange-950 dark:border-orange-800',
  'bg-purple-100 border-purple-300 dark:bg-purple-950 dark:border-purple-800',
  'bg-yellow-100 border-yellow-300 dark:bg-yellow-950 dark:border-yellow-800',
  'bg-red-100 border-red-300 dark:bg-red-950 dark:border-red-800',
  'bg-green-100 border-green-300 dark:bg-green-950 dark:border-green-800',
  'bg-teal-100 border-teal-300 dark:bg-teal-950 dark:border-teal-800',
  'bg-pink-100 border-pink-300 dark:bg-pink-950 dark:border-pink-800',
  'bg-indigo-100 border-indigo-300 dark:bg-indigo-950 dark:border-indigo-800',
  'bg-lime-100 border-lime-300 dark:bg-lime-950 dark:border-lime-800',
] as const;

const LAST = 'bg-slate-200 border-slate-300 dark:bg-slate-800 dark:border-slate-600';

/** Fallback for a key that is not among the stages (should not happen). */
const UNKNOWN = 'bg-gray-50 border-gray-200';

/**
 * The column classes for `key`, given every stage key in pipeline order.
 */
export function boardColumnTone(key: string, orderedKeys: readonly string[]): string {
  const i = orderedKeys.indexOf(key);
  if (i < 0) return UNKNOWN;
  if (orderedKeys.length > 1 && i === orderedKeys.length - 1) return LAST;
  return CYCLE[i % CYCLE.length];
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * The stage color as `#rrggbb`, or null when it is missing or not a plain hex
 * color — never pass a stored value into a style unchecked.
 */
export function stageColorHex(color: string | null | undefined): string | null {
  const c = color?.trim() ?? '';
  if (!HEX.test(c)) return null;
  const hex = c.length === 4 ? `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}` : c;
  return hex.toLowerCase();
}

export type ColumnPaint = {
  className: string;
  style?: { backgroundColor: string; borderColor: string; borderTopColor: string; borderTopWidth: number };
};

/**
 * How to paint the column for `key`: the stage's own color when it has a
 * valid one, otherwise the positional tone. Translucent, so the same wash
 * reads on the light page and on the dark one; the header text keeps its
 * gray, which holds AA on a 14% tint of any color.
 */
export function boardColumnPaint(key: string, orderedKeys: readonly string[], color: string | null | undefined): ColumnPaint {
  const hex = stageColorHex(color);
  if (!hex) return { className: boardColumnTone(key, orderedKeys) };
  return {
    className: '',
    style: { backgroundColor: `${hex}24`, borderColor: `${hex}66`, borderTopColor: hex, borderTopWidth: 4 },
  };
}
