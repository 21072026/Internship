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

export function notificationLink(role: NotificationRole, kind: LinkKind, ids: LinkIds): string {
  const root = ROOTS[role] ?? '/';
  const relationId = validId(ids.relationId);
  const menteeId = validId(ids.menteeId);
  const projectId = validId(ids.projectId);

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
