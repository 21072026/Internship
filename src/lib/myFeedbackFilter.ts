// How far along is what I sent? (#3929) — the one rule the "My feedback" page
// reads for its summary line and its filter, dependency-free so a plain
// `node --experimental-strip-types` unit test can import it.
//
// Five report statuses (src/lib/supportReportStatus.ts) fold into three
// outcomes a reporter cares about:
//   * done     — RESOLVED: the team says it is fixed or answered;
//   * open     — NEW, TRIAGED, IN_PROGRESS: still waiting on the team;
//   * wontFix  — WONT_FIX: decided, but not "done", so it is counted on its
//                own and never inflates "completed".
// An unknown status (a later one this page does not know yet) reads as open:
// waiting is the safe claim, "done" would be a promise.

export const MY_FEEDBACK_FILTERS = ['all', 'open', 'done', 'wontFix'] as const;
export type MyFeedbackFilter = (typeof MY_FEEDBACK_FILTERS)[number];
export type MyFeedbackOutcome = Exclude<MyFeedbackFilter, 'all'>;

export function isMyFeedbackFilter(value: unknown): value is MyFeedbackFilter {
  return typeof value === 'string' && (MY_FEEDBACK_FILTERS as readonly string[]).includes(value);
}

export function feedbackOutcome(status: string): MyFeedbackOutcome {
  if (status === 'RESOLVED') return 'done';
  if (status === 'WONT_FIX') return 'wontFix';
  return 'open';
}

export interface MyFeedbackProgress {
  total: number;
  done: number;
  open: number;
  wontFix: number;
}

export function myFeedbackProgress(reports: readonly { status: string }[]): MyFeedbackProgress {
  const out: MyFeedbackProgress = { total: reports.length, done: 0, open: 0, wontFix: 0 };
  for (const r of reports) out[feedbackOutcome(r.status)] += 1;
  return out;
}

export function filterMyFeedback<T extends { status: string }>(reports: readonly T[], filter: MyFeedbackFilter): T[] {
  return filter === 'all' ? [...reports] : reports.filter((r) => feedbackOutcome(r.status) === filter);
}
