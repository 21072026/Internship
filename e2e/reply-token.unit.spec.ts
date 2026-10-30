// The reply-token format (#1713) — pure, no browser, no database. Old shapes are
// already sitting in real mailboxes, so they must keep verifying unchanged.
import { test, expect } from '@playwright/test';
import { makeConversationReplyToken, makeReplyToken, verifyReplyToken } from '@/lib/replyToken';

test.describe('reply tokens', { tag: '@smoke' }, () => {
  // The signer refuses to run without a secret; a fixed test value is enough here.
  test.beforeAll(() => {
    process.env.NEXTAUTH_SECRET ||= 'reply-token-unit-secret';
  });

  test('relation tokens keep their meaning, bare and scoped', () => {
    expect(verifyReplyToken(makeReplyToken('rel1'))).toEqual({ kind: 'relation', relationId: 'rel1', recipientUserId: null });
    expect(verifyReplyToken(makeReplyToken('rel1', 'u1'))).toEqual({ kind: 'relation', relationId: 'rel1', recipientUserId: 'u1' });
  });

  test('a conversation token names the conversation and its recipient', () => {
    expect(verifyReplyToken(makeConversationReplyToken('conv1', 'u1'))).toEqual({ kind: 'conversation', conversationId: 'conv1', recipientUserId: 'u1' });
  });

  test('a token cannot be re-pointed: changing the target breaks the signature', () => {
    const t = makeConversationReplyToken('conv1', 'u1');
    const sig = t.slice(t.lastIndexOf('.') + 1);
    expect(verifyReplyToken(`c=conv2~u1.${sig}`)).toBeNull();
    // The same ids as a relation token are a different payload, so a different signature.
    expect(verifyReplyToken(`conv1~u1.${sig}`)).toBeNull();
  });
});
