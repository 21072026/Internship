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

**Allowance-aware routing (#2011):** JaaS bills by monthly active user and *every
participant of a JaaS room counts against the allowance* (25 on the free tier), so a room
goes to the tenant only while the month still has room for it. Every kind of meeting is
eligible — one-on-one, group, bulk and recurring series alike — and the decision is made
once per meeting in `resolveMeetingLink()` (`src/lib/meetingRoom.ts`), which asks
`jaasRoomAllowed()` (`src/lib/jaasAllowance.ts`) whether the projected head-count
(invitees + the organiser; a series, whose audience grows later, is booked as a small
group) still fits.

> **What this replaced, and why.** The rule used to be "1:1 calls only": the tenant was
> reserved for pairs because the allowance was a number nobody in the codebase could see.
> That guess had a price and groups paid it — every project meeting, every bulk schedule
> and every recurring series was routed *by construction* to a host that hangs up an
> embedded call after five minutes. A standup that dies at minute five is not a cheaper
> call; it is a broken one. Now the allowance is counted from our own webhook feed, so the
> routing is evidence rather than a proxy.

| | Unconfigured (default) | Configured, allowance has room | Configured, allowance spent |
|---|---|---|---|
| New room links | `https://meet.jit.si/InternshipCRM-<hex>` | `https://8x8.vc/<appId>/InternshipCRM-<hex>` | `https://meet.jit.si/InternshipCRM-<hex>` |
| Embedded panel | plain iframe, **5-minute cutoff** + the warning | `external_api.js` + JWT, no cutoff | plain iframe, **5-minute cutoff** + the warning |
| Display name | typed by whoever joins | filled in from the account | typed by whoever joins |
| Moderator | whoever arrives first | the person who called the meeting (and admins) | whoever arrives first |

**A public room always says so.** Whenever the panel is about to embed a `meet.jit.si`
room it renders `FreeRoomWarning` (`src/components/meeting/FreeRoomWarning.tsx`) above the
call — before anyone joins, in EN/TR/DE, naming both the five-minute cutoff and the escape
from it: the *same* room opened in a browser tab has no cutoff, and the button to do that
is in the warning. It shows for a degraded 1:1 too, because that room dies exactly the
same way; a warning shown only to groups would lie by omission.

**Nothing here gates a call.** Video is free-core. Over-allowance is an announced
degradation, never a refusal — and an unreadable database, a broken key or an unset
variable all resolve the same way: a public room, which is still a room.

### Counting the allowance ourselves

`JaasMonthlyParticipant` is one row per (calendar month, participant), written from the
`PARTICIPANT_JOINED` webhook. `COUNT(*)` over a month is therefore the monthly-active
figure, and `/admin/integrations` renders it as **"18 / 25 monthly active participants"**
(`GET /api/admin/integrations/jaas-usage`).

- **Identity-minimal by construction.** The webhook carries `{ id, name }`; only an
  HMAC-SHA256 of the id is stored and the name is dropped. The key is the deployment's own
  secret, so the table cannot be correlated across deployments, and nothing joins it to a
  `User`.
- **No webhook feed, no count.** With `JAAS_WEBHOOK_SECRET` unset the count stays at zero
  and every room is routed to the tenant — an operator who has not wired the feed has given
  us no evidence of exhaustion, and inventing one would push working calls onto the host
  with the cutoff. The card says "not measured" rather than letting the zero read as
  "nothing used".
- **The limit is configuration, not a literal.** `JAAS_MONTHLY_ACTIVE_LIMIT` (default 25)
  is the one place the number lives; `0` is a deliberate kill switch that keeps every room
  on the public instance without unsetting credentials the feed still needs.

Nothing else changes: the room URL is still emailed to invitees, still opens in any
browser, and rooms created before the switch keep working as they did (the panel keeps
the old iframe path for `meet.jit.si` links).

### Fallback: no meeting is ever stranded

Two layers keep calls possible when JaaS misbehaves:

1. **Creation-time** — no/broken credentials, a spent allowance or a database that cannot
   answer all degrade a new link to `meet.jit.si` (this has always been the unconfigured
   behaviour), and the panel warns about the cutoff before anyone joins. Unsetting the
   `JAAS_*` variables is the kill switch; `JAAS_MONTHLY_ACTIVE_LIMIT=0` is the softer one.
2. **Run-time** — a JaaS room name works verbatim on the free public instance, so from
   any stored `8x8.vc/<appId>/<room>` link the app derives `https://meet.jit.si/<room>`
   (`freeMeetingFallbackLink`, `src/lib/meetingLink.ts`). When the embedded JaaS call
   fails to start (tenant down, MAU quota blocked, token rejected), the panel offers
   **“Continue in the free room”** next to “Open in a new tab”. Everyone who switches
   lands in the same room, because the room name is shared between the two hosts.

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
  Concretely: `/etc/internship-crm/prod.env` and `/etc/internship-crm/preview.env`
  (`chmod 600`); the topic environments read the preview file, so one entry covers every
  `crm-pr<N>` env too.
  ⚠️ The env file is **sourced by the deploy script, not handed to the container** — every
  variable also needs an `-e NAME="${NAME:-}"` line in `infra/deploy-prod.sh` (prod + shared
  preview) and `infra/server/topic-deploy.sh` (topic envs). The `JAAS_*` lines are already
  there; the failure mode if one is missing is silent — the file looks configured while the
  app sees nothing and quietly keeps using the public instance.
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
        │     (the panel only requests a token for 8x8.vc links; a room that was
        │      routed to meet.jit.si takes the plain-iframe path with no token
        │      round trip — 'not-a-jaas-room' answers direct API calls for it)
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

1. Start a call from a mentee card. While the month's allowance has room, the stored link
   should be an `8x8.vc` one:
   `select meetLink from Meeting order by createdAt desc limit 1;`
   If it is a `meet.jit.si` one, `/admin/integrations` says why — no tenant, or the
   allowance spent.
2. `GET /api/meetings/<id>/call-token` as a participant returns `200` with a `jwt`
   (and `Cache-Control: no-store`). A `409` names the reason in `code`.
3. The panel shows the prejoin screen, then the call — and stays up past five minutes.
   If the token were rejected the panel shows the failure view rather than a blank box:
   "open in a new tab" plus the free-room fallback ("Continue in the free room", which
   opens `https://meet.jit.si/<room>` and copies that link).

## Costs and limits

JaaS bills by **monthly active users** with a free allowance (25 on the dev tier) on top
of which usage is charged — and every *participant* of a JaaS room counts, not just the
organizer. The routing above is the spending control: rooms use the tenant while the
projected head-count fits inside `JAAS_MONTHLY_ACTIVE_LIMIT`, and fall back to the public
instance (with the warning) once it does not.

**The number is ours now.** `/admin/integrations` shows "N / limit monthly active
participants" for the current UTC month, counted from the webhook feed rather than read
off the JaaS console, so "is 25 actually the constraint for us?" is answerable from
evidence — which is the whole point of measuring it before deciding to pay for a tier.
It is a report and nothing else: no path in the app returns a 403 for a video reason.

Turning JaaS on for a deployment real people use is still a spending decision. Leaving the
variables unset is always a safe rollback: existing `8x8.vc` links keep opening in a
browser tab (and the panel offers the free-room fallback), and new rooms go back to the
public instance.
