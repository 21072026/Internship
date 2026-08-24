import { test, expect } from '@playwright/test';
import {
  notificationLink,
  type LinkKind,
  type NotificationRole,
} from '@/lib/notificationLink';

const roles = ['ADMIN', 'MENTOR', 'MENTEE', 'COMPANY', 'SOURCE'] as const satisfies readonly NotificationRole[];
const kinds = ['relation', 'thread', 'mentee', 'support', 'project', 'dashboard'] as const satisfies readonly LinkKind[];
const ids = { relationId: 'rel_1', menteeId: 'mentee_1', projectId: 'project_1' };

const expected = {
  ADMIN: {
    relation: '/admin/candidates/mentee_1', thread: '/messages/rel_1', mentee: '/admin/candidates/mentee_1',
    support: '/messages/support', project: '/projects/project_1', dashboard: '/admin',
  },
  MENTOR: {
    relation: '/mentor/mentees/rel_1', thread: '/messages/rel_1', mentee: '/mentor/mentees/rel_1',
    support: '/messages/support', project: '/projects/project_1', dashboard: '/mentor',
  },
  MENTEE: {
    relation: '/portal', thread: '/messages/rel_1', mentee: '/portal',
    support: '/messages/support', project: '/projects/project_1', dashboard: '/portal',
  },
  COMPANY: {
    relation: '/company', thread: '/messages/rel_1', mentee: '/company',
    support: '/messages/support', project: '/projects/project_1', dashboard: '/company',
  },
  SOURCE: {
    relation: '/source', thread: '/messages/rel_1', mentee: '/source',
    support: '/messages/support', project: '/projects/project_1', dashboard: '/source',
  },
} as const satisfies Record<NotificationRole, Record<LinkKind, string>>;

test.describe('notificationLink', () => {
  test('maps every role × kind combination', { tag: '@smoke' }, () => {
    for (const role of roles) {
      for (const kind of kinds) expect(notificationLink(role, kind, ids), `${role} × ${kind}`).toBe(expected[role][kind]);
    }
  });

  test('falls back to the role root when a required ID is missing or malformed', () => {
    expect(notificationLink('MENTOR', 'relation', {})).toBe('/mentor');
    expect(notificationLink('ADMIN', 'mentee', { menteeId: '../other' })).toBe('/admin');
    expect(notificationLink('MENTEE', 'thread', { relationId: '' })).toBe('/portal');
    expect(notificationLink('COMPANY', 'project', { projectId: 'bad/id' })).toBe('/company');
  });

  test('never swaps relationId and menteeId', () => {
    expect(notificationLink('MENTOR', 'relation', { relationId: 'relation', menteeId: 'mentee' })).toBe('/mentor/mentees/relation');
    expect(notificationLink('ADMIN', 'relation', { relationId: 'relation', menteeId: 'mentee' })).toBe('/admin/candidates/mentee');
  });

  test('unknown runtime inputs fall back safely', () => {
    expect(notificationLink('UNKNOWN' as NotificationRole, 'dashboard', {})).toBe('/');
    expect(notificationLink('ADMIN', 'unknown' as LinkKind, {})).toBe('/admin');
  });
});
