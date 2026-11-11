import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { test, expect } from '@playwright/test';
import { commandActionId, COMMAND_NAMES, SLASH_COMMAND } from '@/lib/chat/commands';
import { parseSlackCommand, parseTeamsCommand } from '../src/lib/chat/interactions/envelope';

// Chat commands (#1956): one list (src/lib/chat/chatApp.json) feeds the
// dispatcher and both manifests; a typed command becomes `command.<name>`.

test.describe('chat commands', { tag: '@smoke' }, () => {
  test('every listed command has a handler, and unknown text is help', () => {
    // Read as text: the registry imports server-only modules this browserless spec cannot load.
    const actions = readFileSync('src/lib/chat/interactions/actions.ts', 'utf8');
    for (const name of COMMAND_NAMES) expect(actions).toContain(`registerChatAction('command.${name}'`);
    expect(commandActionId('status')).toBe('command.status');
    expect(commandActionId('  BOOK  next week')).toBe('command.book');
    expect(commandActionId('<at>InternCRM</at> log')).toBe('command.log');
    expect(commandActionId('drop table')).toBe('command.help');
    expect(commandActionId('')).toBe('command.help');
  });

  test('a Slack slash command is our command or nothing', () => {
    const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
    const ok = { command: SLASH_COMMAND, text: 'status', team_id: 'T1', user_id: 'U1', response_url: 'https://hooks.slack.com/commands/x' };
    expect(parseSlackCommand(form(ok))).toMatchObject({ teamId: 'T1', externalUserId: 'U1', actionId: 'command.status', value: null, input: null });
    expect(parseSlackCommand(form({ ...ok, command: '/other' }))).toBeNull();
    expect(parseSlackCommand(form({ ...ok, user_id: 'U1; x' }))).toBeNull();
    expect(parseSlackCommand(form({ ...ok, payload: '{}' }))).toBeNull();
  });

  test('a Teams message is a command with its conversation for the reply', () => {
    const a = { type: 'message', id: 'a1', text: '<at>Bot</at> book', serviceUrl: 'https://smba.trafficmanager.net/emea/', from: { aadObjectId: 'aad-1' }, channelData: { tenant: { id: 'tid' } }, conversation: { id: 'a:conv' } };
    expect(parseTeamsCommand(a)).toMatchObject({ teamId: 'tid', externalUserId: 'aad-1', actionId: 'command.book', conversationRef: { serviceUrl: a.serviceUrl, conversation: { id: 'a:conv' } } });
    expect(parseTeamsCommand({ ...a, type: 'invoke' })).toBeNull();
    expect(parseTeamsCommand({ ...a, from: {} })).toBeNull();
  });

  test('the manifests declare every command, validate, and follow the environment', () => {
    // Run the generator as CI and a deployment do (it is a plain ESM script).
    execFileSync('node', ['scripts/chat-manifest.mjs', '--check']);
    const out = mkdtempSync(join(tmpdir(), 'chat-manifest-'));
    execFileSync('node', ['scripts/chat-manifest.mjs', '--out', out], {
      env: { ...process.env, CHAT_MANIFEST_BASE_URL: 'https://preview.example.test', TEAMS_APP_ID: '11111111-2222-3333-4444-555555555555' },
    });
    const teams = JSON.parse(readFileSync(join(out, 'teams/manifest.json'), 'utf8'));
    const slack = JSON.parse(readFileSync(join(out, 'slack/manifest.json'), 'utf8'));
    expect(teams.bots[0].commandLists[0].commands.map((c: { title: string }) => c.title)).toEqual([...COMMAND_NAMES]);
    expect(teams).toMatchObject({ id: '11111111-2222-3333-4444-555555555555', validDomains: ['preview.example.test'] });
    expect(slack.features.slash_commands[0]).toMatchObject({ command: SLASH_COMMAND, url: 'https://preview.example.test/api/integrations/chat/slack/interactions' });
    // A bad id is refused, not written.
    expect(() =>
      execFileSync('node', ['scripts/chat-manifest.mjs', '--out', out], { env: { ...process.env, TEAMS_APP_ID: 'not-a-guid' }, stdio: 'pipe' }),
    ).toThrow();
  });
});
