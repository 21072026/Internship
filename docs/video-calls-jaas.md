# Video calls: moving the embedded room to JaaS (8x8)

The in-app meeting panel (#1053/#1054) embeds a Jitsi room. Against the **public**
`meet.jit.si` instance that embed is explicitly a demo: the call is cut after five
minutes and Jitsi says so in a banner —

> Embedding meet.jit.si is only meant for demo purposes, so this call will disconnect in 5
> minutes. Please use Jitsi as a Service for production embedding!

**JaaS** (Jitsi as a Service) is the same software on our own 8x8 tenant, addressed as
`https://8x8.vc/<appId>/<room>`, with a signed JWT per participant. #1237 wires the app
up for it; this document is the setup that lives outside the repo.

## What the app does once configured

| | Unconfigured (default) | Configured |
|---|---|---|
| New room links | `https://meet.jit.si/InternshipCRM-<hex>` | `https://8x8.vc/<appId>/InternshipCRM-<hex>` |
| Embedded panel | plain iframe, **5-minute cutoff** | `external_api.js` + JWT, no cutoff |
| Display name | typed by whoever joins | filled in from the account |
| Moderator | whoever arrives first | the person who called the meeting (and admins) |

Nothing else changes: the room URL is still emailed to invitees, still opens in any
browser, and rooms created before the switch keep working as they did (the panel keeps
the old iframe path for `meet.jit.si` links).

## One-time setup in the JaaS console

1. Sign in at <https://jaas.8x8.vc/> and note the **App ID** — `vpaas-magic-cookie-…`.
   It is not a secret; it is part of every room URL.
2. **API keys → Add API key**. Either let the console generate the RSA key pair (download
   the private key — it is shown once) or upload the public half of a pair you generate:

   ```bash
   openssl genrsa -out jaas.key 2048 && openssl rsa -in jaas.key -pubout -out jaas.pub
   ```

3. Copy the **API key ID** shown next to it. It looks like
   `vpaas-magic-cookie-…/ab12cd` and becomes the JWT's `kid`.

## Environment

Three variables, all three or nothing (a half-configured tenant would mint tokens 8x8
rejects, so the app treats it as "off"):

```
JAAS_APP_ID=vpaas-magic-cookie-…
JAAS_API_KEY_ID=vpaas-magic-cookie-…/ab12cd
JAAS_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nMIIE…\n-----END PRIVATE KEY-----\n
```

`.env` files cannot hold real newlines, so `JAAS_PRIVATE_KEY` accepts either the PEM with
literal `\n` escapes or the whole PEM base64-encoded:

```bash
# escaped newlines
perl -pe 's/\n/\\n/g' < jaas.key
# or base64
base64 -i jaas.key | tr -d '\n'
```

Where to put them:

- **Production / preview / demo** — the server's env file for that container (the same
  file `HEALTH_TOKEN` and `CRON_SECRET` live in), then redeploy. Never in the repo.
- **Local dev** — your own `.env`, or leave unset and keep the public rooms.
- **CI / e2e** — leave unset on purpose. The suite asserts the *unconfigured* contract
  (`e2e/meeting-call-token.spec.ts`), and no CI job needs to talk to 8x8.

Preview and production can share one tenant, but they will share its MAU allowance too.

## How it fits together

```
Meeting.meetLink  https://8x8.vc/<appId>/InternshipCRM-<hex>     ← src/lib/meetingRoom.ts
        │
panel   ├─ GET /api/meetings/<id>/call-token                     ← authorizes, then signs
        │     200 { domain, appId, roomName, jwt }                  (src/lib/jaas.ts)
        │     409 { code: 'not-configured' | 'not-a-jaas-room' } → falls back to the link
        │
        └─ new JitsiMeetExternalAPI('8x8.vc', { roomName, jwt })  ← src/components/meeting/JaasCall.tsx
```

- The token is signed **RS256**, `kid` = the API key id, `sub` = the app id, and `room`
  scoped to that one room — never `*`, so a leaked token cannot open another call.
  It lives two hours and is minted per join, never stored.
- Premium features (recording, live streaming, transcription, dial-out) are switched
  **off** in every token. Recording in particular is a consent question
  ([DATA_ACCESS_POLICY.md](DATA_ACCESS_POLICY.md)), not a flag to flip quietly.
- Only meeting participants get a token: `canAccessMeeting` in `src/lib/meetingAccess.ts`
  (mentor/mentee of the relation, project member, chat participant, organizer, admin).
  Everyone else gets a 404 — the same answer as a meeting that does not exist.
- `next.config.js` allows exactly `https://8x8.vc` in `script-src`/`frame-src` and in the
  camera/microphone/display-capture `Permissions-Policy`. Adding a host to
  `EMBEDDABLE_MEETING_HOSTS` without updating both leaves an empty box or a call with no
  camera.

## Verifying after deployment

1. Start a call from a mentee card. The stored link should be an `8x8.vc` one:
   `select meetLink from Meeting order by createdAt desc limit 1;`
2. `GET /api/meetings/<id>/call-token` as a participant returns `200` with a `jwt`
   (and `Cache-Control: no-store`). A `409` names the reason in `code`.
3. The panel shows the prejoin screen, then the call — and stays up past five minutes.
   If the token were rejected the panel falls back to "open in a new tab" rather than
   showing a blank box.

## Costs and limits

JaaS bills by **monthly active users** with a free allowance on top of which usage is
charged. Turning this on for a deployment real people use is a spending decision, and the
usage page in the JaaS console is the only place it is visible — the app does not meter
it. Leaving the variables unset is always a safe rollback: existing `8x8.vc` links keep
opening in a browser tab, and new rooms go back to the public instance.
