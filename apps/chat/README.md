# Chat app manifests

Generated. Do not edit these files by hand.

- `teams/manifest.json`: the Microsoft Teams app manifest, v1.17.
- `slack/manifest.json`: the Slack app manifest.

Both are built from `src/lib/chat/chatApp.json`, the file the app itself reads for its commands and Slack scopes. The steps:

1. Change `src/lib/chat/chatApp.json`.
2. Run `npm run gen:chat-manifest`.
3. Commit the regenerated files.

CI runs `npm run check:chat-manifest`. It fails when these files are stale.

The committed copies point at the default base URL and use a placeholder Teams app id. To build a real environment's package, run the generator with that environment's values:

```bash
CHAT_MANIFEST_BASE_URL=https://<host> TEAMS_APP_ID=<guid> node scripts/chat-manifest.mjs --out /tmp/chat-package
```

The Teams package also needs `color.png` (192×192) and `outline.png` (32×32). Zip them next to the manifest. See `docs/chat-apps.md` § Store-submission checklist.
