# Service level (#1604)

What this deployment commits to about availability, how it is measured, and what does not
count. The public page is `/status`; the incident process behind it is
[`docs/incident-response.md`](incident-response.md).

## The number

**Not published yet.** A percentage on a public page is a commercial promise, so the code
publishes one only when the operator sets `STATUS_SLA_TARGET` (e.g. `99.5`) on the server; unset,
`/status` says that no commitment is published and shows the measurements alone. Values outside
90…99.999 are ignored (`slaTarget()` in `src/lib/statusRule.ts`).

**What this architecture can hold, honestly.** Production, preview, every PR topic environment
and MySQL share one host; a deploy swaps one container (`REPLICAS=1`) and runs `prisma db push`
first. Every deploy is therefore a short outage, and the host is a single point of failure.

| Target | Downtime per 30-day month | Fits this architecture? |
|---|---|---|
| 99.9 % | 43 min | Only with few deploys and no host incident — not safely while every merge to `main` deploys |
| **99.5 %** | 3 h 36 min | Yes, with maintenance windows excluded — the recommended first number |
| 99.0 % | 7 h 12 min | Yes, with margin |

Raising it beyond 99.5 % needs the multi-replica drill (`docs/disaster-recovery.md`) and the
weekly release train (`deploy-prod.yml` header) first.

## Measurement

- **Window:** a calendar month, UTC. `/status` additionally shows a rolling 90 days.
- **Source:** the `status.sample` job writes one `StatusSample` row per 5-minute slot from inside
  the application, through its database, on its scheduler (`src/lib/statusSample.ts`).
- **Downtime:** a slot without a sample. It means the application, its database or its scheduler
  was not running — the page does not claim to know which.
- **Available while degraded:** slow or failing e-mail delivery and a lagging job queue are shown
  as *degraded* and still count as available.
- **Independent check:** an off-box monitor (#1603) probes `/api/health` and pages a human. Its
  results are not yet folded into the figure; the in-app samples are the measurement of record.

## Exclusions

1. **Announced maintenance**, posted on `/status` at least 24 h ahead and at most 4 h a month.
2. **The customer's side:** their network, browser, devices, identity provider or mail system.
3. **Third-party providers** an organisation enables: the SMTP relay's own outages, AI
   providers, calendar sync, hosted video, push services.
4. **Force majeure** and attacks beyond reasonable mitigation (e.g. a volumetric DDoS).
5. **Features marked beta** in the release notes.

## Response and resolution targets

Severity definitions are in [`docs/incident-response.md`](incident-response.md). Targets apply
during the operator's support hours unless stated; they are what a very small team can hold.

| Severity | First response | Status update cadence | Target resolution / workaround |
|---|---|---|---|
| S1 — total outage or data exposure | 1 h, any time | every 2 h | 8 h |
| S2 — a core flow broken for a role | 4 business hours | daily | 2 business days |
| S3 — degraded or partial feature | 1 business day | on change | next release |
| S4 — cosmetic | 3 business days | — | backlog |

## Service credits

None defined. Credits are a contract term, not a code default; an MSA that offers them states
them there and refers to this document for the measurement.
