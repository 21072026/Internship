# Backlog

> **Devralınan doküman — `21072026/Marketing` repo'sundan.** Dikey kararından
> (epic #2348) ÖNCE yazıldı: kendi auth'unu, deploy'unu, `Customer` modelini ve
> marketing'e özel rolleri varsayar; bunların hiçbiri artık geçerli değil.
> Uygulamadan önce `../CURATION.md`'deki KEEP/ADAPT/DROP kararına bakın.
> İçindeki GitHub issue bağlantıları ölüdür.

Every piece of planned work for the SaleVali Marketing CRM, broken into slices
small enough to pick up and finish in one sitting.

**Written in English. Each item carries a one-line German and Turkish summary**
(`DE:` / `TR:`) so the whole team can scan the board without reading the detail.

---

## How this maps onto the board

Nothing here is invented — these are the fields the GitHub board already has.

| Backlog concept | On the board |
| --- | --- |
| **Epic** | Issue type `Feature`, title prefixed `Epic:` |
| **Story** | Issue type `Feature`, a **sub-issue** of its epic |
| **Task** | Issue type `Task`, a **sub-issue** of its story |
| Priority | `Priority` field: **Urgent · High · Medium · Low** |
| Difficulty | `Effort` field: **Low** (easy) · **Medium** · **High** (hard) |
| Newcomer-friendly | `good first issue` label |
| Defects found later | Issue type `Bug` |

Each task also ships a **ready-to-use prompt** — paste it into Claude Code (or
hand it to a developer) and it contains enough context to start without reading
the whole repository.

**Everything below is on the board as issues [#3–#122](https://github.com/21072026/Marketing/issues).**
Hierarchy is wired with task lists in the epic and story bodies, so an epic shows
its progress as its children close. These files stay the long-form reference: the
issues carry the same summaries, criteria and prompts.

## Epics

| # | Epic | Issue | Priority | Why it matters | Tasks |
| --- | --- | --- | --- | --- | --- |
| [1](backlog/epic-01-import.md) | Import the existing customer base | [#3](https://github.com/21072026/Marketing/issues/3) | Urgent | Until the real customers are in, the team keeps using the spreadsheet and the CRM is a parallel universe | 10 |
| [2](backlog/epic-02-trials.md) | Never lose a trial | [#16](https://github.com/21072026/Marketing/issues/16) | Urgent | SaleVali trials run 30 days and never auto-renew — an unattended expiry is a customer lost in silence | 11 |
| [3](backlog/epic-03-analytics.md) | See the funnel | [#31](https://github.com/21072026/Marketing/issues/31) | High | `StageChange` already records every transition; nothing reads it yet | 13 |
| [4](backlog/epic-04-i18n.md) | German and Turkish UI | [#48](https://github.com/21072026/Marketing/issues/48) | High | SaleVali ships DE/EN/TR and the team speaks German and Turkish; the CRM is English-only | 10 |
| [5](backlog/epic-05-operations.md) | Deploy it and keep it running | [#62](https://github.com/21072026/Marketing/issues/62) | High | The pipeline is written but has never run: no server, no runner, no backups on a schedule | 9 |
| [6](backlog/epic-06-access.md) | Access control and data protection | [#74](https://github.com/21072026/Marketing/issues/74) | High | Every role sees every customer, nothing is logged, and there is no way to erase a person | 8 |
| [7](backlog/epic-07-workflow.md) | Daily workflow | [#85](https://github.com/21072026/Marketing/issues/85) | Medium | A customer cannot be edited after creation. The tool has to be pleasant or it will not be used | 13 |
| [8](backlog/epic-08-quality.md) | Test coverage and guardrails | [#102](https://github.com/21072026/Marketing/issues/102) | Medium | Six flows are covered; invitations, campaigns and role gating are not | 7 |
| [9](backlog/epic-09-product-signals.md) | Signals from the SaleVali product | [#112](https://github.com/21072026/Marketing/issues/112) | Low | Usage is the strongest churn predictor, and today every number is typed in by hand | 8 |

**9 epics · 22 stories · 89 tasks**, of which **30** are marked `good first issue`.

Across the 89 tasks:

- **Effort** — 35 Low, 52 Medium, 2 High. Most are meant to be finished in one sitting.
- **Priority** — 13 Urgent, 30 High, 28 Medium, 18 Low.

## Suggested order

1. **Epic 1** first. Everything else operates on data that does not exist yet:
   no customers means no trials to remind about and no transitions to chart.
2. **Epic 2** next — the highest-value feature, and meaningful once there is data.
3. **Epic 5** in parallel with 1–2; it is mostly server work and blocks nothing
   else, but nothing is real until it is deployed.
4. **Epic 3** after a few weeks of transitions have accumulated.
5. **Epic 4** after 1–3. Those epics add new strings; doing i18n first means
   translating everything twice.
6. **Epics 6–9** as the team and the customer base grow.

## Conventions for whoever picks one up

- Read `CLAUDE.md` first, then the specific file for the epic.
- One task, one PR. If a task turns out to hide a second concern, split it and
  say so in the PR.
- Anything that writes `Customer.stage` goes through `lifecycleTimestampsFor()`
  and records a `StageChange` — see `src/lib/lifecycle.ts`.
- New behaviour on a critical path needs an e2e spec. `docs/testing.md` covers
  the `waitForURL()` trap that will otherwise cost you an afternoon.
- A Prisma rename lands as `DROP COLUMN` in production. Say so in the PR.
