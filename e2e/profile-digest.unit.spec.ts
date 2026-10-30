// Unit tests for the profile digest (#2038). Pure node — no browser, no DB, no
// provider: the model is a fake handed to callModel().
//
// Guarded: the source is the person's own labelled text, bounded per field,
// and empty when only skills are known (they are scored elsewhere); the reply
// is read defensively; a refresh calls the model only when the text changed
// or the person asked; and the call sends no name or e-mail and asks for
// English themes, which come back normalised.
import { test, expect } from '@playwright/test';
import type Anthropic from '@anthropic-ai/sdk';
import { DIGEST_MAX_CHARS, digestSourceText, planDigestRefresh, readDigestReply } from '@/lib/profileDigestRule';
import { generateProfileDigest } from '@/lib/ai/profileDigest';

test('the source is the person’s own labelled text, each field bounded', { tag: '@smoke' }, () => {
  const text = digestSourceText({
    bio: '  Six years   of QA. ',
    interests: 'backend, Go',
    targetPosition: 'Backend developer',
    skills: ['Testing', 42, 'SQL'],
    goalTitles: ['Ship a Go service'],
  });
  expect(text).toBe('About: Six years of QA.\nInterests: backend, Go\nTarget position: Backend developer\nSkills: Testing, SQL\nGoals: Ship a Go service');
  expect(digestSourceText({ bio: 'x'.repeat(5000) }).length).toBeLessThan(2100);
});

test('skills alone, or nothing, make no source', { tag: '@smoke' }, () => {
  expect(digestSourceText({ skills: ['React'] })).toBe('');
  expect(digestSourceText({})).toBe('');
});

test('the reply is read defensively: bounded paragraph, normalised themes, or nothing', { tag: '@smoke' }, () => {
  expect(readDigestReply({ digest: ' A tester moving to backend. ', themes: ['Backend Engineering', 'go', 'go', 7] })).toEqual({
    digest: 'A tester moving to backend.',
    themes: ['backend engineering', 'go'],
  });
  expect(readDigestReply({ digest: 'y'.repeat(2000), themes: ['a'] })!.digest).toHaveLength(DIGEST_MAX_CHARS);
  expect(readDigestReply({ digest: '', themes: ['go'] })).toBeNull();
  expect(readDigestReply({ digest: 'ok', themes: [] })).toBeNull();
});

test('a refresh calls the model only for a changed text or an explicit request', { tag: '@smoke' }, () => {
  expect(planDigestRefresh('h1', 'h1')).toBe('unchanged');
  expect(planDigestRefresh('h1', 'h1', true)).toBe('generate');
  expect(planDigestRefresh('h2', 'h1')).toBe('generate');
  expect(planDigestRefresh('h1', null)).toBe('generate');
  expect(planDigestRefresh(null, 'h1')).toBe('remove');
  expect(planDigestRefresh(null, null)).toBe('unchanged');
});

test('the call carries only the profile text, fenced, and asks for English themes', { tag: '@smoke' }, async () => {
  let sent: Anthropic.MessageCreateParamsNonStreaming | null = null;
  const fake = async (params: Anthropic.MessageCreateParamsNonStreaming) => {
    sent = params;
    return {
      id: 'm', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'text', text: JSON.stringify({ digest: 'Moves from testing into backend work in Go.', themes: ['Backend Engineering', 'Go', 'career switch'] }) }],
    } as unknown as Anthropic.Message;
  };
  const source = digestSourceText({ bio: 'QA engineer, reach me at ada@example.test', interests: 'backend' });
  const out = await generateProfileDigest(source, fake);
  expect(out).toEqual({ digest: 'Moves from testing into backend work in Go.', themes: ['backend engineering', 'go', 'career switch'] });
  const input = JSON.stringify(sent!.messages);
  expect(input).not.toContain('ada@example.test');
  expect(String(sent!.system)).toContain('ENGLISH');
});
