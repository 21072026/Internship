// The HTTP answers of the hard-delete refusals (#1584) — one table for the two
// deletion routes. The codes themselves are src/lib/orgDeletionRule.ts.

import type { DeletionRefusal } from '@/lib/orgDeletionRule';

export const DELETION_ERRORS: Record<DeletionRefusal | 'not_found' | 'password_incorrect', { status: number; error: string }> = {
  hard_delete_disabled: { status: 403, error: 'Permanent deletion is switched off on this deployment' },
  not_found: { status: 404, error: 'Organization not found' },
  default_org: { status: 409, error: 'The default organization cannot be deleted' },
  own_org: { status: 409, error: 'You cannot delete the organization you are signed in through' },
  not_archived: { status: 409, error: 'Archive the organization first' },
  slug_mismatch: { status: 400, error: 'Type the organization’s exact slug to confirm' },
  already_requested: { status: 409, error: 'Deletion has already been requested' },
  not_requested: { status: 409, error: 'Request the deletion first' },
  waiting_period: { status: 409, error: 'The waiting period after the request has not passed yet' },
  export_required: { status: 409, error: 'Download a full export after the request before deleting' },
  password_incorrect: { status: 400, error: 'Your password is incorrect' },
};
