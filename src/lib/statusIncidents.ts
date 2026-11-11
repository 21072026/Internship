// The public incident feed of /status (#1604). A typed file, edited in a PR —
// not a table with an admin screen — for three reasons: an incident note is
// reviewed text (the same review a postmortem gets, docs/incident-response.md);
// it must survive the database it may be about; and while the box is down no
// admin screen on it can be used anyway. The cost, stated: posting an update
// takes a merge, i.e. one deploy (~10 min). The component rows above the feed
// change on their own, from the samples, with no deploy.
//
// Rules: newest first; every text in EN, TR and DE (a missing locale is a type
// error); never a customer name, a host, a person or an internal detail — the
// tenant-names rule in CLAUDE.md applies here like everywhere else.
import type { IncidentSeverity } from './statusRule';

type Localized = { en: string; tr: string; de: string };

export interface StatusIncident {
  /** Stable slug, e.g. '2026-11-02-mail-relay'. */
  id: string;
  severity: IncidentSeverity;
  title: Localized;
  /** ISO instants (UTC). */
  startedAt: string;
  resolvedAt: string | null;
  updates: { at: string; text: Localized }[];
}

export const STATUS_INCIDENTS: readonly StatusIncident[] = [];
