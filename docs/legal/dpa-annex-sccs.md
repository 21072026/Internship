# DPA Annex IV — international transfers

> Template annex to [`dpa-template.md`](dpa-template.md). Not legal advice; to be
> reviewed by counsel. Issue #2029.

## 1. The transfer basis between Controller and Processor

- **Default position.** The Controller's data is held by the operator's
  application server and database (row 1 of
  [`../trust/subprocessors.md`](../trust/subprocessors.md)). Where that server is
  in the EEA and the Processor is established in the EEA, there is **no
  restricted transfer** between the parties, and Chapter V does not apply to the
  core hosting. The country is named by the operator on request
  (`docs/trust/hosting-and-residency.md`).
- **EU SCCs, Module 2 (controller → processor).** If either the hosting location
  or the Processor is outside the EEA without an adequacy decision, the parties
  incorporate the Standard Contractual Clauses of Commission Implementing
  Decision (EU) 2021/914, **Module Two**, by reference: Clause 7 (docking)
  `[included / not included]`; Clause 9(a) **Option 2** (general authorisation,
  notice period as in § 7.2 of the DPA); Clause 11 optional redress
  `[not used]`; Clause 17 law of `[an EU Member State]`; Clause 18 courts of
  `[same]`. Annexes I–III of the SCCs are populated from the DPA's annexes.
- **United Kingdom.** For transfers subject to UK GDPR, the parties use the ICO's
  **International Data Transfer Addendum** to the EU SCCs (version B1.0), with
  Table 1–3 populated from the DPA, and Table 4 `[neither party / either party]`
  may end it on a change of the Approved IDTA. A stand-alone IDTA is used only
  where the EU SCCs are not in place.
- **Switzerland.** For transfers subject to the Swiss FADP, the EU SCCs are used
  with the FDPIC's adaptations: the FDPIC is the competent supervisory authority
  for those transfers, "Member State" includes Switzerland for the purpose of
  Clause 18(c), and references to the GDPR are read as references to the FADP.

## 2. Onward transfers to subprocessors

The table covers every subprocessor in the register whose service is, or can be,
outside the EEA. The column "basis in place" says **only what the register
records** — it does not claim a contract this repository has not seen. Where it
says *held by the operator*, the operator must produce that document on request
before a Controller relies on it.

| Register row | Subprocessor | What leaves the server | Transfer mechanism to rely on | Basis in place today (per register) |
|---|---|---|---|---|
| 4 | **Anthropic** (`ANTHROPIC_API_KEY`) | Extracted CV text and task prompts; consent-gated per person | Provider's DPA with EU SCCs Module 3 (processor → sub-processor), or the EU–US Data Privacy Framework if the provider is certified | "Anthropic's commercial terms, held by the operator". `docs/ai.md` § What we do not have states **no signed DPA or zero-retention addendum** and **no guaranteed processing region**. Treat as a gap until a DPA is executed |
| 5 | **Google — Calendar OAuth** | Meeting title, description, times, attendee addresses, the connecting user's OAuth tokens | Google's data-processing terms with SCCs / EU–US DPF | "Google's API terms, held by the operator". Opt-in per user, off unless `GOOGLE_CALENDAR_ENABLED=1` |
| 11 | **Google Analytics 4** | Pageview URL, referrer, truncated IP, device data — public marketing pages only, after cookie consent | Google's Ads/Analytics data-processing terms with SCCs / EU–US DPF | "Google's Analytics terms and standard contractual clauses, held by the operator". Unset in the reference deployment |
| 10 | **PostHog** | Pageview data, public pages only, after consent | None needed while the host is PostHog's EU region; SCCs / DPF if the operator points `NEXT_PUBLIC_POSTHOG_HOST` at a US instance | "PostHog's DPA, held by the operator". Shipped default host is the EU region |
| 9 | **Plausible** | Cookieless pageview data, public pages only, after consent | EU-hosted service or self-hosted — normally no transfer | "Plausible's DPA, held by the operator — or none needed when self-hosted" |
| 6 | **8x8 — JaaS** | Display name, room id, live audio/video stream | 8x8's DPA with SCCs / DPF, depending on the region serving the call | "8x8's JaaS terms, held by the operator" |
| 7 | **8x8 — public `meet.jit.si`** | Display name, room id, live audio/video stream | **None available** — public-service terms only | "Public-service terms only — no contract". Used as fallback and after the JaaS allowance; a Controller that cannot accept this should require JaaS or a bring-your-own meeting link (`docs/video-calls-jaas.md`) |
| 12 | **tawk.to** | Visitor IP and chat text on the operator's public home page, after marketing-cookie consent | Provider's terms with SCCs | "tawk.to's terms, held by the operator". This is the operator's own sales channel; it does not touch the Controller's tenant data |
| 8 | **Browser push services** (Google, Mozilla, Apple — chosen by the user's browser) | Push endpoint and an **end-to-end encrypted** payload | **None available** — the Web Push protocol gives the sender no contractual counterparty | "None available". Mitigation: payload encrypted to the subscriber's keys; opt-in per user |
| 13 | **GitHub** (Actions, container registry) | Source code, build logs, images — **no end-user personal data**; a GitHub issue drafted from an in-app bug report carries path, build and counts only (`buildIssueDraft()`, `docs/feedback-reports.md`) | Not a transfer of the Controller's personal data | "GitHub's terms, held by the operator" |
| 2, 3 | **SMTP relays** | Recipient name and address, mail content | Depends on the relay the operator chooses; SCCs if outside the EEA | "Direct contract with whichever relay the operator points it at" |

## 3. Known gaps to close before signature

1. **Anthropic**: no executed DPA / SCCs and no region guarantee (`docs/ai.md`).
   Until closed, the Controller can keep the AI features switched off (the key
   unset, or the organisation's AI switches off — `docs/ai.md` § Switches).
2. **`meet.jit.si` and browser push**: no contract is obtainable; the Controller
   must accept or avoid them (JaaS / own meeting link; push stays off unless a
   user enables it).
3. **Off-site backups**: `docs/disaster-recovery.md` describes an encrypted
   off-site backup repository at a separate storage provider. It is **not yet a
   row** in the subprocessor register; it must be added (with its location and
   basis) before this annex is relied on.
4. Every "held by the operator" entry above: the operator supplies the document,
   its date and the provider's transfer mechanism on request.

A transfer impact assessment (Clause 14 SCCs) is the exporter's duty per
transfer and is not pre-filled here.
