const DAY_MS = 24 * 60 * 60 * 1000;

/** Canonical Monday 00:00:00.000Z for the UTC calendar week containing input. */
export function utcWeekStart(input: Date): Date {
  if (Number.isNaN(input.getTime())) throw new Error('Invalid date');
  const date = new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date;
}

export function utcWeekEnd(weekStart: Date): Date {
  return new Date(utcWeekStart(weekStart).getTime() + 7 * DAY_MS - 1);
}

export function addUtcWeeks(weekStart: Date, weeks: number): Date {
  return new Date(utcWeekStart(weekStart).getTime() + weeks * 7 * DAY_MS);
}

/** First complete reporting week: a mid-week relation starts reporting next Monday. */
export function firstFullUtcWeek(startDate: Date): Date {
  const week = utcWeekStart(startDate);
  return startDate.getTime() === week.getTime() ? week : addUtcWeeks(week, 1);
}
