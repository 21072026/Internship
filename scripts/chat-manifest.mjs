#!/usr/bin/env node
// The Teams and Slack app manifests (#1956), generated — never hand-edited.
//
//   npm run gen:chat-manifest            writes apps/chat/{teams,slack}/manifest.json
//   npm run check:chat-manifest          (CI) regenerates in memory, validates, and
//                                        fails when the committed files disagree
//
// ONE source: src/lib/chat/chatApp.json (commands, Slack bot scopes, name,
// version, descriptions) — the same file the app's dispatcher and its Slack
// install read, so a command added there cannot ship without the manifests
// following it. The routes the manifests point at are the app's real ones.
//
// The committed copies are generated for the defaults below. A deployment's
// package is the same generator with its own environment:
//   CHAT_MANIFEST_BASE_URL=https://preview.example.test TEAMS_APP_ID=<guid> \
//     node scripts/chat-manifest.mjs --out /tmp/package
// writes that environment's manifests to --out and leaves apps/chat alone.
//
// Validation is offline: the fields and length limits each platform's schema
// enforces and that a reviewer rejects first (Teams manifest v1.17, Slack app
// manifest). It does not replace the platform's own validator before a store
// submission — docs/chat-apps.md § Store-submission checklist.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE = 'https://interncrm.com';
const PLACEHOLDER_TEAMS_ID = '00000000-0000-0000-0000-000000000000';
const app = JSON.parse(readFileSync(join(ROOT, 'src/lib/chat/chatApp.json'), 'utf8'));

export function buildManifests({ baseUrl = DEFAULT_BASE, teamsAppId = PLACEHOLDER_TEAMS_ID } = {}) {
  const base = new URL(baseUrl);
  const origin = base.origin;
  const route = (p) => `${origin}${p}`;
  const commands = app.commands.map((c) => ({ title: c.name, description: c.description }));

  const teams = {
    $schema: 'https://developer.microsoft.com/en-us/json-schemas/teams/v1.17/MicrosoftTeams.schema.json',
    manifestVersion: '1.17',
    version: app.version,
    id: teamsAppId,
    developer: {
      name: app.name,
      websiteUrl: origin,
      privacyUrl: route('/privacy'),
      termsOfUseUrl: route('/terms'),
    },
    name: { short: app.name, full: app.name },
    description: { short: app.description.short, full: app.description.full },
    icons: { color: 'color.png', outline: 'outline.png' },
    accentColor: app.accentColor,
    bots: [
      {
        botId: teamsAppId,
        scopes: ['personal'],
        supportsFiles: false,
        isNotificationOnly: false,
        commandLists: [{ scopes: ['personal'], commands }],
      },
    ],
    permissions: ['identity', 'messageTeamMembers'],
    validDomains: [base.host],
  };

  const slackRoute = (p) => route(`/api/integrations/chat/slack/${p}`);
  const slack = {
    _metadata: { major_version: 1, minor_version: 1 },
    display_information: {
      name: app.name,
      description: app.description.short,
      long_description: app.description.full,
      background_color: app.accentColor,
    },
    features: {
      bot_user: { display_name: app.name, always_online: false },
      slash_commands: [
        {
          command: app.slash,
          url: slackRoute('interactions'),
          description: app.description.short,
          usage_hint: app.commands.map((c) => c.name).join(' | '),
          should_escape: false,
        },
      ],
    },
    oauth_config: {
      redirect_urls: [slackRoute('callback')],
      scopes: { bot: [...app.slackBotScopes] },
    },
    settings: {
      event_subscriptions: { request_url: slackRoute('uninstall'), bot_events: ['app_uninstalled', 'tokens_revoked'] },
      interactivity: { is_enabled: true, request_url: slackRoute('interactions') },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: true,
    },
  };
  return { teams, slack };
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEMVER = /^\d+\.\d+\.\d+$/;

/** The limits a reviewer or the schema rejects first; an empty list is valid. */
export function validateManifests({ teams, slack }) {
  const errors = [];
  const need = (cond, msg) => cond || errors.push(msg);
  need(GUID.test(teams.id), 'teams: id must be a GUID');
  need(SEMVER.test(teams.version), 'teams: version must be x.y.z');
  need(teams.name.short.length <= 30, 'teams: name.short > 30');
  need(teams.description.short.length <= 80, 'teams: description.short > 80');
  need(teams.description.full.length <= 4000, 'teams: description.full > 4000');
  need(/^#[0-9A-Fa-f]{6}$/.test(teams.accentColor), 'teams: accentColor must be #RRGGBB');
  for (const k of ['websiteUrl', 'privacyUrl', 'termsOfUseUrl']) need(teams.developer[k].startsWith('https://'), `teams: developer.${k} must be https`);
  const cmds = teams.bots[0].commandLists[0].commands;
  need(cmds.length > 0 && cmds.length <= 10, 'teams: 1..10 commands per list');
  for (const c of cmds) {
    need(c.title.length <= 32, `teams: command "${c.title}" title > 32`);
    need(c.description.length <= 128, `teams: command "${c.title}" description > 128`);
  }
  need(new Set(cmds.map((c) => c.title)).size === cmds.length, 'teams: duplicate command');
  need(teams.validDomains.every((d) => !d.includes('/') && !d.includes('*')), 'teams: validDomains are bare hosts');
  need(slack.display_information.name.length <= 35, 'slack: name > 35');
  need(slack.display_information.description.length <= 140, 'slack: description > 140');
  need(slack.display_information.long_description.length >= 175 && slack.display_information.long_description.length <= 4000, 'slack: long_description must be 175..4000');
  for (const c of slack.features.slash_commands) {
    need(/^\/[a-z0-9_-]{1,31}$/.test(c.command), `slack: command "${c.command}" must be /lowercase, ≤ 32`);
    need(c.url.startsWith('https://'), 'slack: slash command url must be https');
    need(c.description.length <= 2000, 'slack: slash command description > 2000');
  }
  need(slack.oauth_config.redirect_urls.every((u) => u.startsWith('https://')), 'slack: redirect urls must be https');
  need(slack.settings.interactivity.request_url.startsWith('https://'), 'slack: interactivity url must be https');
  return errors;
}

const serialize = (o) => `${JSON.stringify(o, null, 2)}\n`;

function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const outIdx = args.indexOf('--out');
  const env = outIdx >= 0 ? { baseUrl: process.env.CHAT_MANIFEST_BASE_URL || DEFAULT_BASE, teamsAppId: process.env.TEAMS_APP_ID || PLACEHOLDER_TEAMS_ID } : {};
  const manifests = buildManifests(env);
  const errors = validateManifests(manifests);
  if (errors.length) {
    console.error(`chat manifest invalid:\n  - ${errors.join('\n  - ')}`);
    process.exit(1);
  }
  const outDir = outIdx >= 0 ? resolve(args[outIdx + 1]) : join(ROOT, 'apps/chat');
  const files = { 'teams/manifest.json': serialize(manifests.teams), 'slack/manifest.json': serialize(manifests.slack) };
  if (check) {
    const stale = Object.entries(files).filter(([rel, body]) => {
      const p = join(ROOT, 'apps/chat', rel);
      return !existsSync(p) || readFileSync(p, 'utf8') !== body;
    });
    if (stale.length) {
      console.error(`chat manifest out of date: ${stale.map(([r]) => `apps/chat/${r}`).join(', ')}\nRun \`npm run gen:chat-manifest\` and commit the result.`);
      process.exit(1);
    }
    console.log(`chat manifest OK — ${app.commands.length} commands, both platforms valid and committed.`);
    return;
  }
  for (const [rel, body] of Object.entries(files)) {
    const p = join(outDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  console.log(`chat manifests written to ${outDir}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
