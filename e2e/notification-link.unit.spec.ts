import { test, expect } from '@playwright/test';
import {
  notificationLink,
  type LinkKind,
  type NotificationRole,
} from '@/lib/notificationLink';

const roles = ['ADMIN', 'MENTOR', 'MENTEE', 'COMPANY', 'SOURCE', 'AFFILIATE'] as const satisfies readonly NotificationRole[];
const kinds = ['relation', 'thread', 'mentee', 'support', 'project', 'dashboard', 'requisition'] as const satisfies readonly LinkKind[];
const ids = { relationId: 'rel_1', menteeId: 'mentee_1', projectId: 'project_1' };

const expected = {
  ADMIN: {
    relation: '/admin/candidates/mentee_1', thread: '/messages/rel_1', mentee: '/admin/candidates/mentee_1',
    support: '/messages/support', project: '/projects/project_1', dashboard: '/admin', requisition: '/admin',
  },
  MENTOR: {
    relation: '/mentor/mentees/rel_1', thread: '/messages/rel_1', mentee: '/mentor/mentees/rel_1',
    support: '/messages/support', project: '/projects/project_1', dashboard: '/mentor', requisition: '/mentor',
  },
  MENTEE: {
    relation: '/portal', thread: '/messages/rel_1', mentee: '/portal',
    support: '/messages/support', project: '/projects/project_1', dashboard: '/portal', requisition: '/portal',
  },
  COMPANY: {
    relation: '/company', thread: '/messages/rel_1', mentee: '/company',
    support: '/messages/support', project: '/projects/project_1', dashboard: '/company', requisition: '/company',
  },
  SOURCE: {
    relation: '/source', thread: '/messages/rel_1', mentee: '/source',
    support: '/messages/support', project: '/projects/project_1', dashboard: '/source', requisition: '/source',
  },
  AFFILIATE: {
    relation: '/affiliate', thread: '/messages/rel_1', mentee: '/affiliate',
    support: '/messages/support', project: '/projects/project_1', dashboard: '/affiliate', requisition: '/affiliate',
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

  test('a thread link prefers the conversation over the relation (#1715)', () => {
    expect(notificationLink('MENTEE', 'thread', { conversationId: 'conv_1', relationId: 'rel_1' })).toBe('/messages/c/conv_1');
    expect(notificationLink('MENTOR', 'thread', { relationId: 'rel_1' })).toBe('/messages/rel_1');
    expect(notificationLink('MENTEE', 'thread', { conversationId: '../admin' })).toBe('/portal');
  });

  test('a requisition link opens the role for its company and its admin, the root for everyone else (#1944)', () => {
    expect(notificationLink('COMPANY', 'requisition', { requisitionId: 'req_1' })).toBe('/company/requisitions/req_1');
    expect(notificationLink('ADMIN', 'requisition', { requisitionId: 'req_1' })).toBe('/admin/requisitions/req_1');
    expect(notificationLink('MENTEE', 'requisition', { requisitionId: 'req_1' })).toBe('/portal');
    expect(notificationLink('MENTOR', 'requisition', { requisitionId: 'req_1' })).toBe('/mentor');
    expect(notificationLink('COMPANY', 'requisition', { requisitionId: '../admin' })).toBe('/company');
    expect(notificationLink('COMPANY', 'requisition', {})).toBe('/company');
  });

  test('unknown runtime inputs fall back safely', () => {
    expect(notificationLink('UNKNOWN' as NotificationRole, 'dashboard', {})).toBe('/');
    expect(notificationLink('ADMIN', 'unknown' as LinkKind, {})).toBe('/admin');
  });
});
