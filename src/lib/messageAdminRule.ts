// The admin door of canMessage() (src/lib/conversations.ts), as a pure rule.
//
// An ADMIN may open a 1:1 chat with anyone — in their OWN tenant. It used to
// read "with anyone" outright: the user lookup behind it is not tenant-scoped
// while MT_ENFORCE_ISOLATION is off (every deployment), so org A's admin could
// open a chat with, write to and be read by a user of org B, and B's user could
// do the same towards A's admin. No tenant permission crosses an org, a super
// admin's included (CLAUDE.md, "Admin permissions are one rule").
//
// The tenant comparison is sameTenant() (an org-less side reads as the default
// org, never as "anything goes"); the default org's id is passed in so this
// stays pure and unit-testable.

import { sameTenant } from '@/lib/orgScope';

export interface MessagingSide {
  role: string;
  orgId: string | null;
}

/** Does the admin door open for this pair? Only when one of them is an ADMIN AND both are in one tenant. */
export function adminDoorOpens(a: MessagingSide, b: MessagingSide, defaultOrgId: string): boolean {
  if (a.role !== 'ADMIN' && b.role !== 'ADMIN') return false;
  return sameTenant(a.orgId, b.orgId, defaultOrgId);
}
