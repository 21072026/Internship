// Shared by the holiday-calendar admin routes (#1638): the request shape.
// Next allows a route file to export handlers only; the ADMIN gate stays in
// each route file, where the route-auth analyser can see it.

import { z } from 'zod';

export const MAX_HOLIDAYS = 400;

export const calendarSchema = z.object({
  name: z.string().trim().min(1).max(120),
  text: z.string().max(40_000),
});


