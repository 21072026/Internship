import type { VerticalCapability } from '@/lib/verticals';
import { salesRecordLink } from '@/lib/salesSurface';

export type NotificationRole = 'ADMIN' | 'MENTOR' | 'MENTEE' | 'COMPANY' | 'SOURCE';

export type LinkKind =
  | 'relation'
  | 'thread'
  | 'mentee'
  | 'support'
  | 'project'
  | 'dashboard';

type LinkIds = {
  relationId?: string;
  menteeId?: string;
  projectId?: string;
};

const ROOTS: Record<NotificationRole, string> = {
  ADMIN: '/admin',
  MENTOR: '/mentor',
  MENTEE: '/portal',
  COMPANY: '/company',
  SOURCE: '/source',
};

function validId(value?: string): string | null {
  return value && /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
}

/**
 * `capabilities` is the RECIPIENT's vertical (optional; omitted = the full
 * product, i.e. today's links). A MENTOR whose vertical has the sales surface
 * (#2580) is a sales rep: their record is `/sales/leads/<id>`, not a mentor
 * page they cannot open — the mentor shell would bounce them to the dashboard
 * and lose which record the reminder was about.
 */
export function notificationLink(
  role: NotificationRole,
  kind: LinkKind,
  ids: LinkIds,
  opts?: { capabilities?: readonly VerticalCapability[] },
): string {
  const root = ROOTS[role] ?? '/';
  const relationId = validId(ids.relationId);
  const menteeId = validId(ids.menteeId);
  const projectId = validId(ids.projectId);

  if (opts?.capabilities && (kind === 'relation' || kind === 'mentee' || kind === 'dashboard')) {
    const sales = salesRecordLink(role, opts.capabilities, kind === 'dashboard' ? null : relationId);
    if (sales) return sales;
  }

  if (kind === 'dashboard') return root;
  if (kind === 'support') return '/messages/support';
  if (kind === 'project') return projectId ? `/projects/${projectId}` : root;
  if (kind === 'thread') return relationId ? `/messages/${relationId}` : root;

  if (kind === 'relation' || kind === 'mentee') {
    if (role === 'MENTOR') return relationId ? `/mentor/mentees/${relationId}` : root;
    if (role === 'ADMIN') return menteeId ? `/admin/candidates/${menteeId}` : root;
    if (role === 'MENTEE') return '/portal';
  }

  return root;
}
