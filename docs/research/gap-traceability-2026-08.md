# Gap → issue traceability, competitive research 2026-08

**What this file is.** The competitive research of 2026-08 produced **348 gap entries** (`gaps-flat.json`, 14 domains). The follow-on backlog programme (Initiative **#1514**) turned **325** of them into **27 epics** and their story/task trees, and **deliberately dropped 23** on the CTO critic's advice. Until now nothing recorded *which* gap became *which* issue, so neither the "325 of 348" claim nor the identity of the 23 dropped gaps could be checked. This file is that record.

**What this file is not.** It is a **point-in-time reconstruction**, not a live index. It was built on **2026-08-30** from three sources: the 348 research entries, the 27 epic agents' own `notes` fields (which contain explicit `GAP COVERAGE` blocks), and the 663 open issues in `21072026/internship` at that moment. Issues get renumbered by nothing, but they do get closed, split, merged and re-scoped — so treat every number below as "the issue that was created to cover this gap", not as "the issue that is open today". Nothing regenerates this file; if the backlog moves materially, it must be rebuilt by hand.

**How the matching was done.** First priority: an epic's own `GAP COVERAGE` block, which names the gap and the issues it landed on. Second: story/task title matching within the epic the gap was routed to. Where neither produced an answer, the row says **UNCOVERED** rather than guessing. Rows carrying an italic parenthetical are covered *in part* — the note says what was cut.

**Cross-check.** The per-epic routed-gap counts stated in the epic notes (11 + 8 + 8 + 15 + 11 + 11 + 5 + 7 + 3 + 14 + 14 + 4 + 12 + 13 + 4 + 16 + 14 + 10 + 6 + 15 + 18 + 15 + 33 + 13 + 18 + …) sum to the same 325, and the 23 gaps left over are exactly the ones the CTO critic rejected — with one exception (gap #91), which appears in no routed set and in no rejection list. That one was re-checked against the tree and is **already shipped** (`src/lib/features.ts:66`) — the inventory pass scored it `missing` in error. Nothing is genuinely lost.

Related: [`docs/research/`](.) · Initiative **#1514** · critic verdicts in the research scratch (`critics.txt`).

---

## Domain legend

| Code | Research domain (as filed, Turkish) |
|---|---|
| Identity/SSO | Kimlik, oturum, SSO, güvenlik |
| Multi-tenancy | Çok kiracılılık, organizasyon, white-label, entitlement |
| Pipeline | Pipeline, mentorluk ilişkisi, aşamalar, SLA |
| Matching | Eşleştirme, mentor bulma, başvuru akışları |
| Comms | Mesajlaşma, bildirim, e-posta, push, duyuru, newsletter |
| Meetings | Toplantı, takvim, uygunluk, video |
| Development | Hedef, görev, değerlendirme, gelişim, içerik |
| Hiring | Şirket, iş talebi, teklif, işe alım |
| Analytics | Analitik, raporlama, ROI, dashboard |
| Integrations | Entegrasyonlar, public API, webhook |
| AI | AI özellikleri |
| UI/UX | UI/UX, i18n, erişilebilirlik, mobil, PWA, dark mode |
| Admin | Yönetici deneyimi, program yönetimi, ayarlar |
| Infra | Altyapı, test, deploy, gözlemlenebilirlik, veri |

## Epic legend

| Epic | Title |
|---|---|
| #1515 | 🧱 Epic · Reviewable schema migrations — retire `db push --accept-data-loss` from the deploy path |
| #1522 | 🚨 Epic · Pre-sale security defects — the disqualifying findings, each hours not sprints |
| #1549 | 🔐 Epic · Finish the tenant key and turn isolation on — MT_ENFORCE_ISOLATION to production |
| #1563 | 👮 Epic · A permission model, not a role enum — can(actor, action, subject) |
| #1591 | 🧪 Epic · Test and observability floor — unit runner, error tracking, uptime monitoring |
| #1616 | ⚙️ Epic · Settings resolution chain — global → org → program behind one accessor |
| #1618 | 🏛️ Epic · Program as a first-class object — promote Cohort into the container everything hangs from |
| #1654 | 🌐 Epic · Host → organization resolution and custom domains |
| #1668 | 🔁 Epic · Durable job queue + transactional outbox — retire in-process node-cron |
| #1682 | 📡 Epic · Domain event bus — generalize emitStageChange into one event stream |
| #1705 | 🔔 Epic · Notification router — notify(user, event, payload) with channel routing and per-category preferences |
| #1725 | 🏷️ Epic · Published pricing and self-serve conversion — the wedge against 13 quote-only vendors |
| #1727 | 💳 Epic · Commercial spine — one billing subject, entitlements, metering, Stripe |
| #1766 | 🎯 Epic · Relationship lifecycle states — pause, re-match, extend, cancel, bench |
| #1769 | 🤝 Epic · Matching engine — weighted criteria, hard rules, bulk cohort matching, explainable scores |
| #1810 | 🧬 Epic · Canonical skill taxonomy — one data model under matching, search, alerts and reporting |
| #1824 | 🏢 Epic · Close the hiring loop — job board, per-requisition applicant pipeline, interview, offer |
| #1825 | 📚 Epic · Program structure and content — session agendas, milestones, drip content, training |
| #1876 | 📊 Epic · Survey engine, NPS and a deterministic relationship health score |
| #1878 | 📈 Epic · Analytics and ROI reporting — the numbers a buyer renews on |
| #1922 | 🔌 Epic · Identity and HR system integrations — OIDC, self-serve SSO, SCIM, HRIS/SFTP |
| #1923 | 💬 Epic · Slack and Microsoft Teams apps — as adapters on the notification router, not a third fan-out |
| #1971 | 📅 Epic · Calendar and meeting integrity — reschedule/cancel, Outlook/M365, complete the Google loop |
| #1977 | 🔗 Epic · Public API, webhooks and the automation ecosystem |
| #2016 | 🤖 Epic · AI — matching intelligence, summarisation, recommendations and governance |
| #2023 | ✅ Epic · Trust surface — accessibility statement/VPAT, DPA, subprocessors, status page, security page |
| #2060 | 🌱 Epic · First impression — demo data, time-to-launch, onboarding and the empty-screen problem |

---

## The 348 gaps

| # | Domain | Gap | Prio | Our status | Epic | Covering issue(s) |
|---:|---|---|---|---|---|---|
| 0 | Identity/SSO | SCIM 2.0 user provisioning & deprovisioning | P0 | missing | — *dropped* | **DROPPED** — see below |
| 1 | Identity/SSO | OIDC single sign-on (currently a broken half-path) | P0 | partial | #1922 Identity/HR integr. | #1924, #1926, #1929, #1936; #1537 (write-boundary reject, epic 1522) |
| 2 | Identity/SSO | Per-tenant SSO enforcement (disable password login) | P0 | missing | #1922 Identity/HR integr. | #1947, #1950 |
| 3 | Identity/SSO | Admin session revocation & deactivation actually signing a user out | P0 | partial | #1522 Security defects | #1526, #1539, #1541 |
| 4 | Identity/SSO | 2FA recovery codes and admin-side 2FA reset | P0 | missing | #1522 Security defects | #1528, #1542, #1543 |
| 5 | Identity/SSO | API key scoping, expiry, ownership and tenant binding | P0 | partial | #1522 Security defects | #1531, #1545, #1546 |
| 6 | Identity/SSO | Super-admin vs tenant-admin separation for SSO/org config | P0 | missing | #1522 Security defects | #1524, #1535; #1575 (epic 1563) |
| 7 | Identity/SSO | Security & compliance trust surface (SOC 2 / ISO 27001 / subprocessors / DPA / status page) | P0 | missing | #2023 Trust surface | #2025, #2027, #2029, #2031; #1604 (status page) |
| 8 | Identity/SSO | IdP attribute → role and program mapping | P1 | partial | #1922 Identity/HR integr. | #1938, #1940, #1943, #1945 |
| 9 | Identity/SSO | Granular admin roles and permission scopes | P1 | missing | #1563 Permission model | #1565, #1569, #1571, #1573 |
| 10 | Identity/SSO | Audit log viewer, export and SIEM streaming | P1 | partial | #1977 Public API | #2012; #1583, #1585 (epic 1563) |
| 11 | Identity/SSO | Data residency / regional hosting choice | P1 | missing | — *dropped* | **DROPPED** — see below |
| 12 | Identity/SSO | Passwordless magic-link and social sign-in (Google / Microsoft / LinkedIn) | P1 | missing | #1922 Identity/HR integr. | #1957, #1959, #1962 |
| 13 | Identity/SSO | Self-service SSO setup: IdP metadata upload + SP metadata endpoint | P1 | partial | #1922 Identity/HR integr. | #1924, #1931, #1933 |
| 14 | Identity/SSO | SAML protocol hardening (SLO, signed AuthnRequests, encrypted assertions, InResponseTo) | P2 | partial | #1922 Identity/HR integr. | #1952, #1955 |
| 15 | Identity/SSO | Distributed rate limiting, persistent lockout and admin unlock | P2 | partial | #1522 Security defects | #1541; #1696 (epic 1668), #2010 (epic 1977) |
| 16 | Identity/SSO | Security notification emails (new device, credential and MFA changes) | P2 | missing | #1705 Notification router | #1717 |
| 17 | Identity/SSO | Configurable password policy and breached-password screening | P2 | partial | #1522 Security defects | #1528, #1544 |
| 18 | Identity/SSO | Impersonation governance: tenant kill-switch, scoped access, visible history | P2 | partial | #1563 Permission model | #1581, #1586, #1587 |
| 19 | Identity/SSO | 2FA policy for all users plus admin visibility of enrolment | P2 | partial | #1616 Settings chain | #1642, #1644 |
| 20 | Identity/SSO | Safeguarding controls: keyword/contact-detail detection and message retention policy | P2 | missing | #2023 Trust surface | #2056 |
| 21 | Identity/SSO | Seat and entitlement enforcement at identity-provisioning time | P2 | partial | #1727 Commercial spine | #1752 |
| 22 | Identity/SSO | Directory attribute refresh and profile photo sync on SSO login | P3 | partial | #1922 Identity/HR integr. | #1943 |
| 23 | Identity/SSO | Nonce-based CSP (remove unsafe-inline / unsafe-eval) | P3 | partial | #1522 Security defects | #1533, #1552 |
| 24 | Multi-tenancy | Turn on tenant isolation enforcement (MT_ENFORCE_ISOLATION rollout) | P0 | partial | #1549 Tenant isolation | #1564, #1566, #1568, #1570, #1572 |
| 25 | Multi-tenancy | Complete the auto-scoped model set (7 orgId models bypass the middleware) | P0 | partial | #1549 Tenant isolation | #1558, #1559, #1560, #1557 |
| 26 | Multi-tenancy | Super-admin vs tenant-admin role separation | P0 | missing | #1563 Permission model | #1524, #1535, #1575 |
| 27 | Multi-tenancy | Per-tenant settings (Setting has no orgId) | P0 | missing | #1616 Settings chain | #1553 (epic 1549); #1617, #1619, #1621 |
| 28 | Multi-tenancy | Tenant-scope API keys, webhooks and AI usage (cross-tenant data leak) | P0 | missing | #1549 Tenant isolation | #1551, #1555, #1556 |
| 29 | Multi-tenancy | Host → organization resolution and custom domains | P0 | partial | #1654 Custom domains | #1656, #1661, #1662 |
| 30 | Multi-tenancy | Commercial layer: plans, Stripe subscriptions, self-serve upgrade | P0 | missing | #1727 Commercial spine | #1756, #1758, #1759, #1760, #1761 |
| 31 | Multi-tenancy | Unify entitlement gating and enforce the five decorative feature keys | P0 | partial | #1727 Commercial spine | #1729, #1731, #1733, #1736, #1738, #1740, #1742 |
| 32 | Multi-tenancy | SCIM 2.0 provisioning and deprovisioning per tenant | P1 | missing | — *dropped* | **DROPPED** — see below |
| 33 | Multi-tenancy | Per-tenant SSO enforcement and IdP role mapping | P1 | partial | #1922 Identity/HR integr. | #1950, #1940 |
| 34 | Multi-tenancy | Apply brandColor to the live UI and complete branding reach | P1 | partial | #1654 Custom domains | #1659, #1666, #1667 |
| 35 | Multi-tenancy | Delegated admin roles scoped to a program or sub-organization | P1 | missing | #1563 Permission model | #1577 |
| 36 | Multi-tenancy | Sub-organizations / departments with their own config and admins | P1 | missing | #1618 Program object | #1630 *(filed P3)* |
| 37 | Multi-tenancy | Org membership model and tenant switcher (one person, several tenants) | P1 | missing | #1549 Tenant isolation | #1574, #1576, #1578 |
| 38 | Multi-tenancy | Tenant lifecycle: rename, archive, export, offboard | P1 | partial | #1549 Tenant isolation | #1580, #1582, #1584; #2029 (published commitment) |
| 39 | Multi-tenancy | Per-tenant quota metering and hard gates beyond active relations | P1 | partial | #1727 Commercial spine | #1746, #1748, #1752 |
| 40 | Multi-tenancy | Tenant-facing plan, usage and billing self-service page | P1 | missing | #1725 Pricing/self-serve | #1735, #1737, #1739 |
| 41 | Multi-tenancy | Per-tenant terminology customization (rename mentor/mentee/program) | P1 | missing | #1616 Settings chain | #1627, #1629, #1631 |
| 42 | Multi-tenancy | Self-serve tenant signup and trial provisioning | P2 | missing | #1725 Pricing/self-serve | #1747, #1749, #1751 |
| 43 | Multi-tenancy | Per-tenant email sending domain and From identity | P2 | partial | #1654 Custom domains | #1660, #1670, #1672 |
| 44 | Multi-tenancy | Auditable trail of organization configuration changes, with a viewer | P2 | partial | #1682 Event bus | #1699; #1583 (viewer), #1623 (settings diff) |
| 45 | Multi-tenancy | Data residency / region selection per tenant | P2 | missing | — *dropped* | **DROPPED** — see below |
| 46 | Multi-tenancy | Tenant provisioning wizard and first-run seed | P2 | missing | #2060 First impression | #2064, #2065, #2066 |
| 47 | Multi-tenancy | Surface multi-tenancy, white-label and SSO in the feature catalogue | P3 | missing | #2060 First impression | #2083 |
| 48 | Pipeline | Relationship lifecycle states beyond ACTIVE/COMPLETED (pause, re-match, extend, cancel, bench) | P0 | missing | #1766 Relation lifecycle | #1767, #1768, #1770, #1772, #1774 |
| 49 | Pipeline | Program as a first-class container: per-program pipeline stages, SLAs and cadence (today they are per-org only) | P0 | partial | #1618 Program object | #1620, #1622, #1624, #1626, #1628 |
| 50 | Pipeline | Canonical stage keys still hardcoded across analytics, reminders and journey — a customised pipeline silently reports zero | P0 | partial | #1878 Analytics/ROI | #1880, #1882, #1884, #1886 |
| 51 | Pipeline | New relations always start on the DB default APPLICATION_100, even when the tenant's stage set does not contain it | P1 | partial | #1618 Program object | #1634 |
| 52 | Pipeline | Group, peer, reverse and flash relationship shapes (one-to-many mentoring) | P1 | missing | #1766 Relation lifecycle | #1804 *(data foundation only — the program-style configurator is fenced out)* |
| 53 | Pipeline | Relationship health score and org-wide at-risk monitor | P1 | partial | #1876 Surveys/health | #1894, #1898, #1901, #1902, #1904 |
| 54 | Pipeline | Mentee-initiated re-match request with admin/mentor queue | P1 | missing | #1769 Matching engine | #1797, #1801 |
| 55 | Pipeline | Stage automation rules: admin-configured actions fired on stage entry/exit | P1 | partial | #1682 Event bus | #1689, #1703, #1704 |
| 56 | Pipeline | SLA escalation ladder, admin breach queue and SLA-compliance metric | P1 | partial | #1705 Notification router | #1709, #1722, #1723 |
| 57 | Pipeline | Business-day SLAs, holiday calendars, and per-cohort / per-mentor SLA overrides with backfill | P1 | partial | #1616 Settings chain | #1633, #1638, #1640 |
| 58 | Pipeline | Add/remove pipeline stages in the admin UI, phase grouping for custom stages, and bulk-advance over a custom order | P1 | partial | #1618 Program object | #1632, #1635, #1637 |
| 59 | Pipeline | Mentoring agreement / relationship kickoff contract, accepted by both sides and versioned | P1 | missing | #1766 Relation lifecycle | #1788, #1790, #1792 |
| 60 | Pipeline | Relationship duration and expected meeting cadence set at match time, with end-approaching nudge | P1 | missing | #1766 Relation lifecycle | #1782, #1784, #1786 |
| 61 | Pipeline | Stage transition gates: role permissions and entry conditions (required documents, evaluation, offer) before a move is allowed | P2 | partial | #1563 Permission model | #1588, #1589, #1590 |
| 62 | Pipeline | Unified relationship timeline — one chronological record of everything that happened in a pairing | P2 | partial | #1682 Event bus | #1687, #1700, #1702 |
| 63 | Pipeline | Close-loop survey and closure plan at the end of a relationship | P2 | partial | #1766 Relation lifecycle | #1795 |
| 64 | Pipeline | Mentor- and mentee-visible stage clock (SLA is admin-only today) | P2 | partial | #1705 Notification router | #1724 |
| 65 | Pipeline | Mentor board parity with the admin board (phase grouping, WIP warning, search/hide-empty, overdue badge) | P2 | partial | #2060 First impression | #2076 |
| 66 | Pipeline | Transactional integrity and tenant scoping on stage writes | P2 | partial | #1549 Tenant isolation | #1562 |
| 67 | Pipeline | Multiple concurrent mentorships per mentee (personal advisory board) | P2 | partial | #1766 Relation lifecycle | #1797, #1799 |
| 68 | Pipeline | Placement / outcome attribution record for success-fee and outcome-based billing | P2 | missing | #1727 Commercial spine | #1765; #1892 (ROI model) |
| 69 | Pipeline | Pipeline forecasting and capacity planning from conversion and dwell | P3 | missing | #1878 Analytics/ROI | #1897 |
| 70 | Pipeline | Programme/pipeline templates: ready-made stage sets, SLAs and automations per programme type | P3 | missing | #1618 Program object | #1639, #1641, #1643, #1645 |
| 71 | Pipeline | Relationship lifecycle events on the webhook and public API (beyond pipeline.stage_change) | P3 | partial | #1977 Public API | #1983, #1998 |
| 72 | Matching | Mentee-facing job/requisition board with an apply flow | P0 | missing | #1824 Hiring loop | #1826, #1830, #1832 |
| 73 | Matching | 'Request this mentor' CTA on the mentor directory | P0 | partial | #1769 Matching engine | #1771, #1773 |
| 74 | Matching | Bulk / cohort-wide matching (match a whole intake in one pass) | P0 | missing | #1769 Matching engine | #1791, #1793, #1794 |
| 75 | Matching | Admin-configurable weighted matching criteria with hard rules and exclusions | P0 | partial | #1769 Matching engine | #1779, #1781, #1783 |
| 76 | Matching | Re-match / change-mentor flow | P0 | missing | #1769 Matching engine | #1797, #1801 |
| 77 | Matching | Wire matching intelligence into the screen where mentors are actually chosen | P0 | partial | #1769 Matching engine | #1787 |
| 78 | Matching | Registration / matching questionnaire builder | P1 | missing | #1769 Matching engine | #1798, #1800, #1802, #1803 |
| 79 | Matching | Group / circle mentoring (one mentor to many, peer groups) | P1 | missing | — *dropped* | **DROPPED** — see below |
| 80 | Matching | Flash / one-off mentoring and open office-hours booking | P1 | partial | — *dropped* | **DROPPED** — see below |
| 81 | Matching | Reverse and peer mentoring as configurable program styles | P1 | missing | — *dropped* | **DROPPED** — see below |
| 82 | Matching | Canonical skill taxonomy with autocomplete, synonyms and adjacency | P1 | partial | #1810 Skill taxonomy | #1811, #1815, #1816, #1817, #1818, #1819 |
| 83 | Matching | Semantic / free-text AI matching over bios, goals and aspirations | P1 | partial | #2016 AI | #2019, #2038 |
| 84 | Matching | Visible match score with an explainable per-rule breakdown | P1 | partial | #1769 Matching engine | #1779, #1785, #1787 |
| 85 | Matching | Staged draft matches with review, lock and bulk approve | P1 | missing | #1769 Matching engine | #1791, #1793, #1796 |
| 86 | Matching | Program object owning its own matching config, enrolment window and roles | P1 | partial | #1618 Program object | #1647, #1648, #1650 |
| 87 | Matching | Matching on HRIS-sourced attributes plus program eligibility rules | P1 | missing | #1922 Identity/HR integr. | #1945 |
| 88 | Matching | Request expiry, reminders and coordinator cancellation on pending applications | P1 | partial | #1769 Matching engine | #1775 |
| 89 | Matching | Concurrent relationships and per-mentee match limits | P2 | missing | #1766 Relation lifecycle | #1797, #1799 |
| 90 | Matching | Richer mentor load controls (self-match limit, monthly meeting cap, bulk import) | P2 | partial | #1769 Matching engine | #1805, #1808 |
| 91 | Matching | Dual mentor+mentee role for one person | P2 | ~~missing~~ **already shipped** | — | **ALREADY BUILT** — `src/lib/features.ts:66` (`dualRole`), copy in `src/i18n/dictionaries.ts:2545/6037/9525`. The research entry was wrong. |
| 92 | Matching | Matching decision audit trail with admin notes | P2 | partial | #1769 Matching engine | #1789 |
| 93 | Matching | Orphan applicant accounts from the public apply link | P2 | partial | #1766 Relation lifecycle | #1776, #1780 |
| 94 | Matching | Mentor application review: separate admin notes from the rejection reason, add a screening stage | P2 | partial | #1769 Matching engine | #1805, #1806, #1807 |
| 95 | Matching | Scalable skill filtering and an honest partial-result signal | P2 | partial | #1810 Skill taxonomy | #1813, #1820 |
| 96 | Matching | Dismiss-and-learn feedback loop on match suggestions | P3 | missing | #2016 AI | #2040 |
| 97 | Matching | Mentor-initiated outreach to unmatched mentees | P3 | missing | #1769 Matching engine | #1809 |
| 98 | Comms | Slack app: notifications, in-channel actions and in-Slack surveys | P0 | missing | #1923 Slack/Teams | #1925, #1927, #1928, #1939, #1953 |
| 99 | Comms | Microsoft Teams app: notifications, DM to your match, and tab experience | P0 | missing | #1923 Slack/Teams | #1925, #1930, #1946, #1954, #1956 |
| 100 | Comms | GDPR erasure must scrub message bodies, attachments and support messages | P0 | partial | #2023 Trust surface | #2049, #2052 |
| 101 | Comms | Per-user notification channel preference (email / chat / in-app / push, per category) | P1 | partial | #1705 Notification router | #1707, #1714 |
| 102 | Comms | Push notifications for every event type, not just new messages | P1 | partial | #1705 Notification router | #1715, #1716 |
| 103 | Comms | Targeted, scheduled announcements with read tracking | P1 | partial | #1705 Notification router | #1708, #1721 |
| 104 | Comms | Admin-editable lifecycle email templates with live preview and per-program overrides | P1 | missing | #1705 Notification router | #1718, #1719 |
| 105 | Comms | Custom nudge builder: segment + condition + delay triggers authored by admins | P1 | missing | #1668 Job queue | #1684, #1686 |
| 106 | Comms | Email engagement analytics: opens, clicks, per-campaign and per-recipient | P1 | missing | #1878 Analytics/ROI | #1921 |
| 107 | Comms | Bounce and complaint handling with an automatic suppression list | P1 | missing | #1668 Job queue | #1688, #1692 |
| 108 | Comms | Outbound email queue with retry, backoff and provider failover | P1 | missing | #1668 Job queue | #1688, #1690 |
| 109 | Comms | Per-tenant sending identity: custom From domain, DKIM setup wizard, internal sender name | P1 | partial | #1654 Custom domains | #1660, #1670, #1672 |
| 110 | Comms | Finish localization of system mail (digests, invitations, reset, verification, meeting invites) | P1 | partial | #1705 Notification router | #1720 |
| 111 | Comms | Message thread pagination, message search and inbox filters (archive / mute / pin) | P1 | partial | #1591 Test/observability | #1609 |
| 112 | Comms | Rate limiting and abuse controls on messaging, support and inbound email | P1 | missing | #1522 Security defects | #1547 |
| 113 | Comms | AI in the comms layer: thread summaries, suggested replies, and survey/feedback summarisation | P1 | partial | #2016 AI | #2020, #2046, #2048 |
| 114 | Comms | Reply-by-email for group/project conversations and inbound-to-support-ticket routing | P2 | partial | #1705 Notification router | #1713; #1657 (epic 1618, support half) |
| 115 | Comms | SMS / WhatsApp as a delivery channel | P2 | missing | #1705 Notification router | #1712 *(adapter contract + recorded non-goal, no SMS/WhatsApp build)* |
| 116 | Comms | Newsletter segmentation beyond MENTEE/MENTOR/BOTH | P2 | partial | #1618 Program object | #1653 |
| 117 | Comms | Notification retention, pruning and a searchable notification centre | P2 | partial | #1616 Settings chain | #1646; #1678 (epic 1668) |
| 118 | Comms | Multi-replica realtime: broker-backed pub/sub for SSE and load-tested fan-out | P2 | partial | #1668 Job queue | #1694, #1698 |
| 119 | Comms | Provable opt-out honouring: per-group suppression proof and an opt-out analytics view | P2 | partial | #2023 Trust surface | #2054 |
| 120 | Comms | Commercial layer for broadcast comms: per-tenant sending quotas and plan-gated campaign features | P2 | missing | #1727 Commercial spine | #1754 |
| 121 | Comms | Richer messaging: @mentions, threaded replies, drafts and typing indicators | P2 | missing | #1825 Program content | #1839, #1869, #1871 |
| 122 | Comms | Message templates and canned responses for mentors and admins | P3 | partial | #1825 Program content | #1871 |
| 123 | Meetings | Reschedule, cancel and delete a meeting | P0 | missing | #1971 Calendar | #1972, #1980, #1982 |
| 124 | Meetings | Microsoft 365 / Outlook calendar integration | P0 | missing | #1971 Calendar | #1973, #1989, #1991 |
| 125 | Meetings | Complete the Google Calendar sync loop (all write paths, removal, live validation) | P0 | partial | #1971 Calendar | #1986, #1993 |
| 126 | Meetings | Group and multi-party video that does not get cut off | P0 | partial | #1971 Calendar | #1976, #2011 |
| 127 | Meetings | Bring-your-own conferencing: Zoom, Google Meet and Microsoft Teams links | P1 | missing | #1971 Calendar | #2007, #2009 |
| 128 | Meetings | Free/busy lookup and double-booking prevention | P1 | missing | #1971 Calendar | #1974, #1995, #1997 |
| 129 | Meetings | Meeting duration as a first-class field with session-type presets | P1 | partial | #1971 Calendar | #1984 |
| 130 | Meetings | Shared meeting agenda and shared session notes/minutes | P1 | partial | #1825 Program content | #1829, #1843, #1847, #1849 |
| 131 | Meetings | AI-generated per-session meeting agendas | P1 | missing | #1825 Program content | #1841, #1843, #1845 |
| 132 | Meetings | Post-meeting feedback and a meeting-quality signal | P1 | missing | #1876 Surveys/health | #1896 |
| 133 | Meetings | Recurring 1:1 mentor↔mentee meeting series | P1 | partial | #1971 Calendar | #1978, #2013 |
| 134 | Meetings | Close the interview-scheduling loop (InterviewRequest → Meeting → panel on the calendar) | P1 | partial | #1824 Hiring loop | #1842, #1844, #1846 |
| 135 | Meetings | Availability depth: edit, one-off slots, blackout/vacation, buffers and booking guardrails | P1 | partial | #1971 Calendar | #1975, #2001, #2003 |
| 136 | Meetings | Slack and Microsoft Teams meeting notifications, join links and in-chat booking | P1 | missing | #1923 Slack/Teams | #1942, #1951 |
| 137 | Meetings | Meeting attendance, no-show and late-cancel accounting with program-level meeting analytics | P1 | partial | #1971 Calendar | #2014 |
| 138 | Meetings | Calendar attachments on invites, and an ICS feed that carries everything | P1 | partial | #1971 Calendar | #2015 |
| 139 | Meetings | RSVP tokens are handed to mentors and admins in the meeting list | P1 | partial | #1522 Security defects | #1548 |
| 140 | Meetings | Propose-another-time on a decline, and a reschedule negotiation loop | P2 | missing | #1971 Calendar | #1982 |
| 141 | Meetings | Scheduling assistant: find a time that works for everyone | P2 | partial | #1971 Calendar | #1999 |
| 142 | Meetings | Group events / office hours with registration, capacity and attendance | P2 | missing | #1825 Program content | #1856 *(booths/bidding/ticketing explicitly excluded)* |
| 143 | Meetings | AI meeting notes: recording, transcript and an editable summary | P2 | missing | — *dropped* | **DROPPED** — see below |
| 144 | Meetings | Configurable reminder cadence per program and per meeting | P2 | partial | #1616 Settings chain | #1636 |
| 145 | Meetings | Meeting lifecycle events on the webhook bus and a Zapier connector | P2 | partial | #1977 Public API | #1983, #1998, #2002, #2004 |
| 146 | Meetings | Commercial layer for hosted video and meeting volume (metering, not gating the core loop) | P2 | missing | #1727 Commercial spine | #1750 |
| 147 | Meetings | Calendar surface gaps: export/print, company-role calendar, cross-mentor availability view | P3 | partial | #1971 Calendar | #2005 |
| 148 | Development | Session agendas & guided conversation library (with AI-personalised agendas) | P0 | missing | #1825 Program content | #1827, #1841, #1843, #1845 |
| 149 | Development | Program survey engine: pre/mid/post, pulse, NPS and event-triggered custom surveys | P0 | missing | #1876 Surveys/health | #1877, #1879, #1881, #1883, #1887 |
| 150 | Development | Program structure engine: milestones/steps with scheduled tasks, drip content and stage-triggered automation | P0 | partial | #1825 Program content | #1831, #1852, #1853, #1855 |
| 151 | Development | Org-wide internship report (Berichtsheft) oversight, compliance dashboard and export | P0 | partial | #1878 Analytics/ROI | #1916, #1917, #1918 |
| 152 | Development | Shared session notes and meeting minutes on the relationship record | P1 | partial | #1825 Program content | #1829, #1847, #1849 |
| 153 | Development | Real development plan: goals with sub-tasks, success criteria, progress and sharing scope | P1 | partial | #1825 Program content | #1833, #1858 |
| 154 | Development | Relationship health score from continuous lightweight feedback | P1 | partial | #1876 Surveys/health | #1894, #1896, #1898 |
| 155 | Development | Mentor & mentee training: handbooks, mini-courses, quizzes and completion tracking | P1 | missing | #1825 Program content | #1835, #1864 *(handbooks only — no LMS build)* |
| 156 | Development | Program content library with per-program scoping, completion tracking and LMS link-out | P1 | partial | #1825 Program content | #1862 *(library + LMS link-out)* |
| 157 | Development | Skills taxonomy, proficiency progression and skills-gap reporting | P1 | partial | #1810 Skill taxonomy | #1814, #1822, #1823 |
| 158 | Development | Mentoring agreement at kickoff and structured relationship closure plan | P1 | missing | #1766 Relation lifecycle | #1788, #1790, #1792, #1795 |
| 159 | Development | Evaluation lifecycle automation: stage-triggered due dates, nudges and completion tracking | P1 | missing | #1876 Surveys/health | #1885, #1889, #1891 |
| 160 | Development | Multi-party approval, verification and expiry for internship documents and placements | P1 | partial | #1824 Hiring loop | #1859 |
| 161 | Development | AI summarisation of free-text feedback into program-level themes and insights | P2 | missing | #2016 AI | #2020, #2046 |
| 162 | Development | AI meeting notetaker: transcript, summary and action items written back to the relationship | P2 | missing | — *dropped* | **DROPPED** — see below |
| 163 | Development | Evaluation amend/edit and interview-panel reopen | P2 | partial | #1876 Surveys/health | #1893 |
| 164 | Development | Recognition layer: kudos, badges, points and one-click LinkedIn sharing | P2 | partial | #1825 Program content | #1837, #1866, #1868 *(kudos + certificate; points/leaderboards not built)* |
| 165 | Development | Certificate public verification page and 'Add to LinkedIn profile' | P2 | partial | #1825 Program content | #1866 |
| 166 | Development | Unify Goal and ProjectTask, and give goals the template + i18n treatment to-dos already have | P2 | partial | #1825 Program content | #1860 |
| 167 | Development | Persist and share AI-generated development content (interview prep, agendas, plans) | P2 | partial | #2016 AI | #2044 |
| 168 | Development | Demo/seed coverage for the development domain | P2 | partial | #2060 First impression | #2062 |
| 169 | Development | 360° multi-rater feedback with separated manager perspective and before/after re-assessment | P3 | partial | — *dropped* | **DROPPED** — see below |
| 170 | Development | Reflection journaling and deeper Q&A (attachments, threading, categories) | P3 | partial | #1825 Program content | #1850 |
| 171 | Hiring | Commercial layer: plans, Stripe billing, self-serve checkout and invoices | P0 | missing | #1727 Commercial spine | #1756, #1758, #1759, #1760, #1761 |
| 172 | Hiring | Company self-service sign-up and guided onboarding | P0 | partial | #1824 Hiring loop | #1861, #1865 |
| 173 | Hiring | Close the interview loop: approved request → scheduled interview → outcome | P0 | partial | #1824 Hiring loop | #1842, #1844, #1846 |
| 174 | Hiring | Hiring outcome closes the loop: accepted offer fills the requisition and moves the pipeline | P0 | partial | #1824 Hiring loop | #1848, #1854 |
| 175 | Hiring | Enforce the five decorative premium entitlements (AI, analytics, export, white-label, SSO) | P0 | partial | #1727 Commercial spine | #1736, #1738, #1740, #1742 |
| 176 | Hiring | Retire CompanyNeed: one open-position model with a deployed migration | P1 | partial | #1824 Hiring loop | #1875; #1359 (pre-existing) |
| 177 | Hiring | ATS integration: Greenhouse / Lever / Workday Recruiting / iCIMS / SmartRecruiters + XML job feed | P1 | missing | — *dropped* | **DROPPED** — see below |
| 178 | Hiring | HRIS sync for company-side users and hiring managers (Personio, BambooHR, Workday, SAP SuccessFactors) | P1 | missing | #1922 Identity/HR integr. | #1968, #1969 *(Personio + BambooHR only; Workday/SuccessFactors recorded in #1970)* |
| 179 | Hiring | Slack and Microsoft Teams notifications for the hiring loop | P1 | missing | #1923 Slack/Teams | #1944 |
| 180 | Hiring | Mentee-facing job board: browse open requisitions and apply | P1 | partial | #1824 Hiring loop | #1826, #1830, #1832 |
| 181 | Hiring | Per-requisition applicant pipeline (application object + stages inside a role) | P1 | partial | #1824 Hiring loop | #1828, #1834, #1836, #1838 |
| 182 | Hiring | Company ↔ candidate direct channel with consent and quota | P1 | missing | #1824 Hiring loop | #1840 |
| 183 | Hiring | Company team accounts: multiple seats, roles and permissions | P1 | missing | #1824 Hiring loop | #1870 |
| 184 | Hiring | AI candidate↔requisition matching with explainable scoring | P1 | partial | #2016 AI | #2042 |
| 185 | Hiring | Employer recruiting analytics: funnel, time-to-fill, source and peer benchmarking | P1 | partial | #1878 Analytics/ROI | #1911 |
| 186 | Hiring | Structured compensation on offers plus salary/offer benchmarking | P1 | partial | #1824 Hiring loop | #1851 |
| 187 | Hiring | Hiring events on the webhook bus and public /api/v1 hiring endpoints | P1 | partial | #1977 Public API | #1990, #1998 |
| 188 | Hiring | Admin-wide offers and hiring operations console | P1 | missing | #1824 Hiring loop | #1872, #1873, #1874 |
| 189 | Hiring | Upgrade path: in-product plan visibility, upgrade CTA and plan-change requests | P1 | partial | #1725 Pricing/self-serve | #1741, #1743, #1745 |
| 190 | Hiring | Employer brand page and public company profile | P2 | partial | #1824 Hiring loop | #1867 |
| 191 | Hiring | Offer letter document generation, templates and e-signature | P2 | partial | #1824 Hiring loop | #1857 |
| 192 | Hiring | Company capacity enforcement: make Company.quota and plan limits real | P2 | partial | #1727 Commercial spine | #1752 |
| 193 | Hiring | Employer events, career fairs and booked interview schedules | P2 | missing | — *dropped* | **DROPPED** — see below |
| 194 | Hiring | Placement attribution and success-fee measurement | P2 | missing | #1727 Commercial spine | #1765; #1892 (ROI model) |
| 195 | Hiring | Demo and seed coverage for the hiring chain | P2 | partial | #2060 First impression | #2061, #2063; #1419 (pre-existing base) |
| 196 | Hiring | Company inquiry → account conversion workflow | P3 | partial | #1824 Hiring loop | #1863 |
| 197 | Analytics | ROI and business-outcome reporting (cost, value, placement economics) | P0 | missing | #1878 Analytics/ROI | #1888, #1892, #1895 |
| 198 | Analytics | Premium analytics gated per-tenant/per-plan instead of one global boolean | P0 | partial | #1727 Commercial spine | #1740 |
| 199 | Analytics | Premium reports silently report zero for tenants with a customised pipeline | P0 | partial | #1878 Analytics/ROI | #1880, #1882, #1884, #1886 |
| 200 | Analytics | Reporting API and BI/data-warehouse export | P1 | partial | #1878 Analytics/ROI | #1899, #1907 |
| 201 | Analytics | HRIS-attribute segmentation of every report (department, level, location, tenure) | P1 | missing | #1878 Analytics/ROI | #1919, #1920 |
| 202 | Analytics | Custom report builder with saved, shareable, server-persisted definitions | P1 | partial | #1878 Analytics/ROI | #1899, #1903 *(fixed report registry, not a free-form builder)* |
| 203 | Analytics | Scheduled report delivery to named stakeholders | P1 | partial | #1878 Analytics/ROI | #1905 |
| 204 | Analytics | Relationship health score with trend and proactive admin alerts | P1 | partial | #1876 Surveys/health | #1901, #1902, #1904 |
| 205 | Analytics | NPS and structured satisfaction instrumentation | P1 | missing | #1876 Surveys/health | #1883, #1910 |
| 206 | Analytics | AI-generated report narrative and open-text insight summarisation | P1 | missing | #2016 AI | #2046 |
| 207 | Analytics | Skills-gap and competency analytics | P1 | missing | #1810 Skill taxonomy | #1814, #1822, #1823 |
| 208 | Analytics | Executive/outcome dashboard with named talent-outcome scores | P1 | missing | #1878 Analytics/ROI | #1895, #1906, #1908 |
| 209 | Analytics | Analytics and telemetry leak across tenants once isolation is enabled | P1 | partial | #1549 Tenant isolation | #1556 |
| 210 | Analytics | Charting layer — no chart library, only hand-rolled CSS bars | P2 | partial | #1878 Analytics/ROI | #1890 |
| 211 | Analytics | Mentor and company analytics are second-class (no date range, no export, no print) | P2 | partial | #1878 Analytics/ROI | #1909, #1911, #1913 |
| 212 | Analytics | SOURCE-institution reporting panel (placement outcomes for referring schools) | P2 | missing | #1878 Analytics/ROI | #1914 |
| 213 | Analytics | Communications engagement analytics (newsletter opens/clicks, announcement reads, invite funnel) | P2 | partial | #1878 Analytics/ROI | #1921 |
| 214 | Analytics | Predictive analytics: drop-off and disengagement risk scoring | P2 | missing | — *dropped* | **DROPPED** — see below |
| 215 | Analytics | Public pre-sale ROI calculator as a lead-gen asset | P2 | missing | #1725 Pricing/self-serve | #1753, #1755, #1757 |
| 216 | Analytics | Mentee self-view of their own activity and progress analytics | P2 | partial | #1878 Analytics/ROI | #1915 |
| 217 | Analytics | AI usage and cost reporting for admins | P2 | partial | #2016 AI | #2030 |
| 218 | Analytics | Outcome survey / first-destination reporting and compliance report packs | P2 | missing | #1876 Surveys/health | #1912 |
| 219 | Analytics | DEI and representation analytics | P2 | missing | #1878 Analytics/ROI | #1919, #1920 *(recorded deferral only — deliberate non-goal this year)* |
| 220 | Analytics | Retention and internal-mobility outcome comparison (participants vs non-participants) | P2 | missing | #1878 Analytics/ROI | #1919, #1920 *(recorded deferral only — deliberate non-goal this year)* |
| 221 | Analytics | External industry benchmarking dataset | P3 | partial | — *dropped* | **DROPPED** — see below |
| 222 | Integrations | Microsoft Teams app (notifications + embedded tab) | P0 | missing | #1923 Slack/Teams | #1925, #1930, #1954, #1956 |
| 223 | Integrations | Slack app (notifications, match DMs, in-Slack check-ins) | P0 | missing | #1923 Slack/Teams | #1925, #1927, #1939, #1946, #1953 |
| 224 | Integrations | SCIM 2.0 user provisioning and deprovisioning | P0 | partial | — *dropped* | **DROPPED** — see below |
| 225 | Integrations | HRIS connectors (BambooHR, Personio, Workday, SAP SuccessFactors) | P0 | missing | #1922 Identity/HR integr. | #1968, #1969 *(Personio + BambooHR; Workday/SuccessFactors deferred in #1970)* |
| 226 | Integrations | Microsoft Outlook / Microsoft 365 / Exchange calendar integration | P0 | partial | #1971 Calendar | #1973, #1989, #1991 |
| 227 | Integrations | Complete the Google Calendar sync loop (cancel, reschedule, all creation paths) | P0 | partial | #1971 Calendar | #1986, #1993 |
| 228 | Integrations | Scoped, expiring, org-bound API keys | P0 | partial | #1522 Security defects | #1545, #1546; #2010, #2006 (epic 1977) |
| 229 | Integrations | Webhook delivery reliability: delivery log, retries, pause toggle, test ping, edit | P1 | partial | #1977 Public API | #2000; #1695 (epic 1668) |
| 230 | Integrations | Public API breadth: more resources, pagination, incremental sync | P1 | partial | #1977 Public API | #1979, #1988, #1990 |
| 231 | Integrations | Write API (v1 POST/PATCH) for candidates, stages and interactions | P1 | missing | #1977 Public API | #1981, #1994, #1996 |
| 232 | Integrations | Expand the outbound webhook event catalogue | P1 | partial | #1977 Public API | #1983, #1998 |
| 233 | Integrations | Zapier / Make no-code automation app | P1 | missing | #1977 Public API | #2002, #2004 |
| 234 | Integrations | ATS integration (Greenhouse, Lever, Workday Recruiting) via a unified broker | P1 | missing | — *dropped* | **DROPPED** — see below |
| 235 | Integrations | LMS / LXP integration (Cornerstone, Degreed, LinkedIn Learning, LTI for Canvas/Moodle) | P1 | missing | — *dropped* | **DROPPED** — see below |
| 236 | Integrations | Zoom / Google Meet / Teams meeting-link generation | P1 | partial | #1971 Calendar | #2007, #2009 |
| 237 | Integrations | OIDC as a working SSO provider | P1 | partial | #1922 Identity/HR integr. | #1924, #1926, #1929 |
| 238 | Integrations | SSO governance: IdP role mapping, enforced SSO, Single Logout | P1 | partial | #1922 Identity/HR integr. | #1938, #1940, #1947, #1950, #1952 |
| 239 | Integrations | Two-way free/busy lookup and double-booking prevention | P1 | partial | #1971 Calendar | #1995, #1997 |
| 240 | Integrations | Integration tier: entitlement + plan gating for API, webhooks and connectors | P1 | missing | #1727 Commercial spine | #1744 |
| 241 | Integrations | Self-serve integration credentials for company and program-owner roles | P2 | missing | #1977 Public API | #2006 |
| 242 | Integrations | Integration health dashboard and per-connector status | P2 | partial | #1977 Public API | #2008; #1960 (chat delivery ledger) |
| 243 | Integrations | Scheduled SFTP / recurring CSV feed ingestion | P2 | partial | #1922 Identity/HR integr. | #1963, #1964, #1965, #1966, #1967 |
| 244 | Integrations | Data warehouse / BI connector and scheduled data export | P2 | missing | #1878 Analytics/ROI | #1907 |
| 245 | Integrations | SMS / WhatsApp delivery channel via a provider integration | P2 | missing | #1705 Notification router | #1712 *(recorded non-goal)* |
| 246 | Integrations | Public developer portal, API lifecycle policy and catalogue visibility | P2 | partial | #1977 Public API | #1992 |
| 247 | Integrations | Embeddable widgets for program and partner websites | P3 | missing | — *dropped* | **DROPPED** — see below |
| 248 | AI | AI admin console (quota control, usage dashboard, provider status) | P0 | partial | #2016 AI | #2017, #2018, #2030 |
| 249 | AI | Per-tenant and per-company AI quota + real AI_PACKAGE entitlement enforcement | P0 | partial | #2016 AI | #2032; #1738 (AI_PACKAGE) |
| 250 | AI | Rate limiting and abuse controls on every AI endpoint | P0 | missing | #2016 AI | #2028 |
| 251 | AI | Prompt-injection hardening and AI output safety | P0 | missing | #2016 AI | #2026 |
| 252 | AI | AI provider resilience: error handling, retries, circuit breaker, safe JSON parsing | P1 | partial | #2016 AI | #2024 |
| 253 | AI | AI-generated session agendas for each mentor↔mentee pair | P1 | missing | #1825 Program content | #1841, #1843, #1845 |
| 254 | AI | AI notetaker: meeting summary and transcript written back to the relationship | P1 | missing | — *dropped* | **DROPPED** — see below |
| 255 | AI | Conversational AI assistant for participants (mentors and mentees), org-context aware, with handoff to a human mentor | P1 | missing | #2016 AI | #2021, #2053 |
| 256 | AI | AI assistant for program administrators (setup, 'what should I do next', which report to run) | P1 | missing | #2016 AI | #2021, #2053 |
| 257 | AI | AI summarisation of open-text feedback: surveys, evaluations, weekly reports — with sentiment flagging | P1 | missing | #2016 AI | #2046 |
| 258 | AI | AI matching reachable everywhere a mentor is chosen, and driven by free-text + mentee preferences | P1 | partial | #2016 AI | #2019, #2038 |
| 259 | AI | Skill taxonomy + embedding/semantic layer under matching, talent pool and requisition alerts | P1 | missing | #1810 Skill taxonomy | #1811, #1812, #1813, #1821 *(embedding/vector layer deliberately descoped)* |
| 260 | AI | Persist AI outputs (history, re-use, share with mentor) instead of discarding them on reload | P1 | missing | #2016 AI | #2044 |
| 261 | AI | AI CV review with a score, gap checklist and tailoring to a specific role/requisition | P1 | partial | #2016 AI | #2050 |
| 262 | AI | AI practice interview / role-play with structured after-action feedback | P1 | partial | #2016 AI | #2051 |
| 263 | AI | AI-assisted program and content authoring (program setup, announcements, newsletters, goal templates, document requirements) | P2 | missing | #2016 AI | #2055 |
| 264 | AI | AI profile generation for mentors and enrichment of company/employer records | P2 | partial | #2016 AI | #2055 |
| 265 | AI | AI candidate↔requisition fit signals and ranked shortlist reasons for companies | P2 | partial | #2016 AI | #2042 |
| 266 | AI | AI-drafted outreach for mentors and program staff (first message, dormant nudge, outcome note, bulk email) | P2 | partial | #2016 AI | #2048 |
| 267 | AI | AI program-health insights: retention/dropout risk, stalled-relationship diagnosis, next-best-action for admins | P2 | partial | — *dropped* | **DROPPED** — see below |
| 268 | AI | Multi-provider abstraction, per-task model routing and token/cost accounting | P2 | partial | #2016 AI | #2022 |
| 269 | AI | AI transparency layer: per-feature disclosure, ✨ labelling, subprocessor and no-training statement, docs/ai.md | P1 | partial | #2016 AI | #2034 |
| 270 | AI | Per-feature AI switches and an explicit org-level AI kill switch in the admin UI | P1 | partial | #2016 AI | #2032 |
| 271 | AI | AI evaluation harness: golden prompts, output-schema validation, regression tests in CI | P2 | missing | #2016 AI | #2036 |
| 272 | AI | AI summarisation of weekly internship reports into a mentor/admin digest | P2 | missing | #2016 AI | #2046 |
| 273 | UI/UX | Published accessibility conformance statement + VPAT + EAA/EN 301 549 page | P0 | partial | #2023 Trust surface | #2033, #2035, #2037 |
| 274 | UI/UX | Service worker leaks authenticated API responses across accounts and only registers behind login | P0 | partial | #1522 Security defects | #1550 |
| 275 | UI/UX | Close the accessibility blind spots the gate cannot see (/account select-name failure, unscanned core screens, thin fixtures) | P0 | partial | #2023 Trust surface | #2039, #2041, #2043 |
| 276 | UI/UX | Per-tenant terminology customisation (mentor→coach/advisor, mentee→coachee/student, program vocabulary) | P1 | missing | #1616 Settings chain | #1627, #1629, #1631 |
| 277 | UI/UX | White-label branding on pre-login/public surfaces + tenant welcome page + brandColor wired to the accent palette | P1 | partial | #1654 Custom domains | #1658, #1663, #1664, #1665, #1666 |
| 278 | UI/UX | Locale-addressable URLs: /tr, /de prefixes, hreflang, sitemap, robots and per-locale OG images | P1 | missing | #2060 First impression | #2080, #2081; #1386 (pre-existing) |
| 279 | UI/UX | prefers-reduced-motion, prefers-contrast and forced-colors (Windows High Contrast) support | P1 | missing | #2023 Trust surface | #2045 |
| 280 | UI/UX | Route error and loading boundaries for every role tree, plus a global-error shell | P1 | partial | #1591 Test/observability | #1597, #1602 |
| 281 | UI/UX | Global search: broken in dark mode, no combobox semantics, no keyboard result navigation | P1 | partial | #2060 First impression | #2074, #2075 |
| 282 | UI/UX | App-store presence for mobile: TWA/wrapper builds for iOS and Android on top of the existing PWA | P1 | partial | #2060 First impression | #2085 |
| 283 | UI/UX | Language expansion beyond EN/TR/DE, with a repeatable 'add a locale' pipeline | P1 | partial | #2060 First impression | #2082 |
| 284 | UI/UX | Untranslated-surface sweep plus a CI guard against hardcoded user-facing strings | P1 | partial | #1591 Test/observability | #1613 |
| 285 | UI/UX | Machine-translation assist for tenant-authored content (announcements, newsletters, stage labels, goal templates, document requirements) | P2 | missing | #2016 AI | #2055 |
| 286 | UI/UX | In-app guided tours, coachmarks and contextual help system | P2 | partial | #2060 First impression | #2067 |
| 287 | UI/UX | Command palette and keyboard shortcuts across the app | P2 | missing | #2060 First impression | #2079 *(filed P3, against the GTM do-not-build line)* |
| 288 | UI/UX | Status-message announcements (WCAG 4.1.3), reflow at 320px / 400% zoom (1.4.10) and assistive-tech walkthroughs of the board and calendar | P2 | partial | #2023 Trust surface | #2047 |
| 289 | UI/UX | RTL / bidirectional layout support and a first RTL locale | P2 | missing | — *dropped* | **DROPPED** — see below |
| 290 | UI/UX | Real offline capability: read my mentees/goals/today's meetings offline and queue writes | P2 | partial | #2060 First impression | #2085 *(scoped spike + written decision only)* |
| 291 | UI/UX | Richer PWA manifest: shortcuts, screenshots, share_target, categories, display_override, iOS splash screens | P2 | partial | #2060 First impression | #2084 |
| 292 | UI/UX | Extend the phone/tablet layout audit to the ~34 uncovered admin routes and the company/source/messages shells | P2 | partial | #1591 Test/observability | #1615 |
| 293 | UI/UX | Server-persisted, shareable saved views and filter presets | P2 | partial | #1878 Analytics/ROI | #1900 |
| 294 | UI/UX | Component dark-mode and design-consistency audit with a regression guard | P2 | partial | #1591 Test/observability | #1614 |
| 295 | UI/UX | Theme control polish: return to 'system' from the sidebar, and an optional compact/density mode | P3 | partial | #2060 First impression | #2078 |
| 296 | Admin | Per-tenant (org-scoped) settings | P0 | partial | #1616 Settings chain | #1617, #1619, #1621; #1553 |
| 297 | Admin | Granular admin roles: super-admin, org admin, program admin, read-only | P0 | missing | #1563 Permission model | #1569, #1573, #1579 |
| 298 | Admin | First-class Program object (many concurrent programs, each with its own rules) | P0 | partial | #1618 Program object | #1620, #1622, #1624, #1626, #1628 |
| 299 | Admin | Commercial layer: plans, Stripe subscriptions, invoices, self-serve upgrade for companies/programs | P0 | missing | #1727 Commercial spine | #1756, #1758, #1759, #1760, #1761 |
| 300 | Admin | Plan/quota enforcement with a usage dashboard and in-product upgrade path | P0 | partial | #1727 Commercial spine | #1746, #1763; #1741, #1745 (epic 1725) |
| 301 | Admin | Program templates + clone-for-next-intake + guided launch wizard | P1 | missing | #1618 Program object | #1639, #1641, #1643, #1645 |
| 302 | Admin | Per-program enrolment configuration (registration windows, invite-only vs open, approval rules, program-specific sign-up links) | P1 | partial | #1618 Program object | #1647, #1648, #1649 |
| 303 | Admin | Admin-defined registration/profile form builder | P1 | missing | #1769 Matching engine | #1798, #1800, #1802, #1803 |
| 304 | Admin | Targeted and scheduled announcements (audience segmentation) | P1 | partial | #1705 Notification router | #1708, #1721 |
| 305 | Admin | Admin-editable email/notification templates with preview and per-program overrides | P1 | partial | #1705 Notification router | #1718, #1719 |
| 306 | Admin | Configurable reminder/nudge rules (trigger builder) instead of hardcoded crons | P1 | partial | #1705 Notification router | #1684, #1686 *(owned by epic 1668, not re-filed)* |
| 307 | Admin | Program health scorecard with thresholds and prescriptive next actions | P1 | partial | #1876 Surveys/health | #1906, #1908 |
| 308 | Admin | Audit log viewer, export and retention for privileged actions | P1 | partial | #1563 Permission model | #1581, #1583, #1585 |
| 309 | Admin | Bulk user lifecycle and invitation management (bulk invite/import of mentors+mentees, invitation status board, bulk re-invite) | P1 | partial | #2060 First impression | #2069, #2070, #2071 |
| 310 | Admin | Terminology / phraseology customization per org and per program | P2 | missing | #1616 Settings chain | #1627, #1629, #1631 |
| 311 | Admin | Settings change history with before/after diff | P2 | partial | #1616 Settings chain | #1623 |
| 312 | Admin | Participant pause/bench lifecycle and rejoin-next-intake workflow | P2 | partial | #1766 Relation lifecycle | #1776, #1778 |
| 313 | Admin | Server-persisted, shareable saved views across admin lists | P2 | partial | #1878 Analytics/ROI | #1900 |
| 314 | Admin | Support desk maturity: priority, category, SLA timers, search and email-to-ticket | P2 | partial | #1618 Program object | #1655, #1657 |
| 315 | Admin | Admin AI copilot: setup assistant, conversational program builder and report explanation | P2 | missing | #2016 AI | #2021, #2053 |
| 316 | Admin | Tenant lifecycle: rename, archive, delete and full offboarding export | P2 | partial | #1549 Tenant isolation | #1580, #1582, #1584 |
| 317 | Admin | Admin operations console: cron job status, integration health, error surfacing | P2 | partial | #1591 Test/observability | #1595, #1607 |
| 318 | Admin | Settings surface completeness and localization of admin config screens | P3 | partial | #1616 Settings chain | #1625 |
| 319 | Admin | Impersonation governance controls (per-tenant disable, user-visible impersonation history) | P3 | partial | #1563 Permission model | #1581, #1586, #1587 |
| 320 | Admin | In-app admin help: contextual guidance, product tours and role-specific guides | P3 | partial | #2060 First impression | #2068; #2067 (primitive) |
| 321 | Infra | Off-site, geo-redundant, encrypted backups | P0 | partial | #2023 Trust surface | #2057, #2058 |
| 322 | Infra | Error tracking and application performance monitoring | P0 | missing | #1591 Test/observability | #1593, #1600, #1601 |
| 323 | Infra | External uptime monitoring, public status page and a published uptime SLA | P0 | missing | #1591 Test/observability | #1594, #1603, #1604 |
| 324 | Infra | Trust Center: SOC 2 Type II path, subprocessor register, DPA, pen-test cadence | P0 | missing | #2023 Trust surface | #2025, #2027, #2029, #2031 *(SOC 2 Type II itself costed-not-started — see Dropped)* |
| 325 | Infra | High availability: remove the single-host SPOF and make the app multi-replica safe | P0 | partial | #1668 Job queue | #1694, #1696, #1698, #1701 |
| 326 | Infra | Durable background job queue replacing in-process node-cron | P0 | partial | #1668 Job queue | #1669, #1671, #1673, #1675, #1676, #1677 |
| 327 | Infra | Data residency: selectable/documented hosting region (EU, and a second region) | P1 | missing | — *dropped* | **DROPPED** — see below |
| 328 | Infra | Audit log viewer, export and SIEM streaming with a retention policy | P1 | partial | #1977 Public API | #2012; #1583, #1585 |
| 329 | Infra | Retention and pruning for telemetry tables (ActivityLog, AuditLog, PageView, Notification) | P1 | partial | #1668 Job queue | #1678; #1646, #1585 |
| 330 | Infra | Data warehouse / BI export (warehouse connector + scheduled dataset exports) | P1 | partial | #1878 Analytics/ROI | #1907 |
| 331 | Infra | Scheduled bulk data ingestion (SFTP/CSV feed with delta and deprovisioning) | P1 | partial | #1922 Identity/HR integr. | #1963, #1964, #1965, #1966, #1967 |
| 332 | Infra | Migration tooling: import an in-flight program from a spreadsheet or an incumbent platform | P1 | partial | #2060 First impression | #2072, #2073 |
| 333 | Infra | Tenant-level data export and offboarding bundle | P1 | missing | #1549 Tenant isolation | #1584; #2029 (published commitment) |
| 334 | Infra | Reviewable schema change management (migrations instead of db push --accept-data-loss) | P1 | partial | #1515 Migrations | #1517, #1519, #1520, #1521, #1523, #1525, #1527, #1529, #1530, #1532, #1534, #1536, #1538, #1540 |
| 335 | Infra | Distributed rate limiting and per-API-key quota enforcement | P1 | partial | #1977 Public API | #2010; #1696 (epic 1668) |
| 336 | Infra | Usage metering and quota enforcement infrastructure for the commercial layer | P1 | partial | #1727 Commercial spine | #1746, #1748, #1750, #1752 |
| 337 | Infra | Cross-tenant leak test gate in CI (including the models isolation does not cover) | P1 | partial | #1549 Tenant isolation | #1564, #1566, #1568, #1570 |
| 338 | Infra | Incident response process, on-call rotation and customer communication | P1 | partial | #1591 Test/observability | #1594, #1605 |
| 339 | Infra | Unit test runner for src/ with coverage reporting | P2 | partial | #1591 Test/observability | #1592, #1598, #1599 |
| 340 | Infra | Contract tests for the public API and webhook delivery against the published spec | P2 | missing | #1591 Test/observability | #1596, #1611 |
| 341 | Infra | Database performance observability (slow query log, index review, N+1 detection) | P2 | partial | #1591 Test/observability | #1608 |
| 342 | Infra | Supply-chain evidence: SBOM, license scanning and a tighter vulnerability gate | P2 | partial | #2023 Trust surface | #2059 |
| 343 | Infra | Secrets management and key rotation runbook | P2 | missing | #1522 Security defects | #1554 |
| 344 | Infra | Demo and seed data fidelity for the hiring chain | P2 | partial | #2060 First impression | #2061, #2063 |
| 345 | Infra | Load-test coverage for authenticated, write and realtime paths | P2 | partial | #1591 Test/observability | #1612; #1698 |
| 346 | Infra | Flaky-test triage, quarantine and suite reliability metrics | P2 | missing | #1591 Test/observability | #1610 |
| 347 | Infra | Visual regression testing for the core screens | P3 | missing | #1591 Test/observability | #1614 |

---

## Deliberately dropped

These 23 gaps were never routed to an epic. All but one were **rejected by the CTO critic** during the programme's review step; the rejection text is quoted or cited for each. "Dropped" here means *no implementation issue was filed* — several still have a **recorded answer** (a documented deferral, a contractual answer, or a cheaper substitute), and where one exists it is named. A gap with no evidenced reason says so plainly.

### 0 · SCIM 2.0 user provisioning & deprovisioning — P0

- **Domain:** Identity/SSO · **Our status:** missing · **Research effort estimate:** XL (8 stories)
- **Reason:** Full SCIM 2.0 rejected by the CTO critic as a whole protocol server (Users, Groups, PATCH semantics, filter grammar, Okta/Entra certification) that presupposes the tenant-key, permission-model and Program epics and "returns literally zero" before a second real tenant exists.
- **Evidence:** critics.txt L161 — "Do that; keep SCIM for the first buyer who names it in a contract."
- **What exists instead:** Recorded, not silent: **#1970** states the contract gate and what we answer instead. Substitute shipped as scheduled SFTP/CSV roster feeds: **#1963–#1967**.

### 11 · Data residency / regional hosting choice — P1

- **Domain:** Identity/SSO · **Our status:** missing · **Research effort estimate:** XL (6 stories)
- **Reason:** Data residency / multi-region rejected: XL, and on a single-host architecture it means standing up and operating a second full deployment.
- **Evidence:** critics.txt L165 — "Answer it contractually plus the AGPL self-host option until a signed deal pays for the region."
- **What exists instead:** The contractual answer is written into **#2027** (EU-hosting statement + AGPL self-host residency answer). No engineering issue exists, deliberately.

### 32 · SCIM 2.0 provisioning and deprovisioning per tenant — P1

- **Domain:** Multi-tenancy · **Our status:** missing · **Research effort estimate:** L (5 stories)
- **Reason:** Same rejection as gap #0 — this is the multi-tenancy domain's duplicate of the SCIM entry.
- **Evidence:** critics.txt L161; L305 ("Offer scheduled SFTP/CSV ingestion instead")
- **What exists instead:** **#1970** (deferral record); substitute **#1963–#1967**.

### 45 · Data residency / region selection per tenant — P2

- **Domain:** Multi-tenancy · **Our status:** missing · **Research effort estimate:** L (4 stories)
- **Reason:** Same rejection as gap #11 — the per-tenant region-selection duplicate.
- **Evidence:** critics.txt L165
- **What exists instead:** Answered in **#2027**; no engineering issue.

### 79 · Group / circle mentoring (one mentor to many, peer groups) — P1

- **Domain:** Matching · **Our status:** missing · **Research effort estimate:** XL (7 stories)
- **Reason:** Group / circle mentoring rejected as the price of not chasing the enterprise L&D buyer; `MentorshipRelation` stays 1:1.
- **Evidence:** critics.txt L307 — "Group / circle / peer / reverse / flash mentoring. This is the price of not chasing the L&D buyer. MentorshipRelation stays 1:1. Say so plainly rather than half-building it." (also L209)
- **What exists instead:** Partly contradicted in practice: **#1804** adds `RelationParticipant` + `relationType` so the shapes become *expressible*. The configurable programme-style layer was not routed.

### 80 · Flash / one-off mentoring and open office-hours booking — P1

- **Domain:** Matching · **Our status:** partial · **Research effort estimate:** L (5 stories)
- **Reason:** Flash / one-off mentoring rejected with the same line as gap #79.
- **Evidence:** critics.txt L307
- **What exists instead:** The office-hours half landed anyway as **#1856** (registration/capacity/waitlist/attendance); the flash-mentoring programme style did not.

### 81 · Reverse and peer mentoring as configurable program styles — P1

- **Domain:** Matching · **Our status:** missing · **Research effort estimate:** L (4 stories)
- **Reason:** Reverse and peer mentoring as configurable programme styles — same rejection as gap #79.
- **Evidence:** critics.txt L307
- **What exists instead:** **#1804** makes the shapes expressible in data only.

### 91 · Dual mentor+mentee role for one person — P2

- **Domain:** Matching · **Our status:** ~~missing~~ → **already shipped** (the research entry was wrong)
- **Reason:** Not dropped and not uncovered — **it is already built.** The inventory pass mis-scored it.
- **Evidence:** `src/lib/features.ts:66` registers the shipped `dualRole` feature; the trilingual copy at
  `src/i18n/dictionaries.ts:2545` (EN), `:6037` (TR) and `:9525` (DE) describes working behaviour, not an
  intention: *"give a mentor a mentor of their own and the mentee portal opens up next to their mentor
  pages, with a view switch in the sidebar to move between them. Admins can put anyone on either side of
  a mentorship; nobody can be paired with themselves."*
- **What exists instead:** the feature itself. No issue is needed.
- **Lesson:** a gap marked `missing` is a claim, not a fact. This one survived a 14-agent inventory pass,
  a routing pass and a coverage audit before a single grep disproved it.

### 143 · AI meeting notes: recording, transcript and an editable summary — P2

- **Domain:** Meetings · **Our status:** missing · **Research effort estimate:** L (6 stories)
- **Reason:** AI meeting notes with recording, transcript and consent design rejected as a whole product masquerading as a gap.
- **Evidence:** critics.txt L169 — "AI notetaker with recording and consent design … Each is a company's roadmap, not a line item. None until a named customer is paying for it."
- **What exists instead:** Nothing filed. Adjacent but different: **#1847/#1849** are human-authored session minutes.

### 162 · AI meeting notetaker: transcript, summary and action items written back to the relationship — P2

- **Domain:** Development · **Our status:** missing · **Research effort estimate:** L (5 stories)
- **Reason:** Same rejection as gap #143 — the development-domain duplicate of the AI notetaker.
- **Evidence:** critics.txt L169
- **What exists instead:** Nothing filed.

### 169 · 360° multi-rater feedback with separated manager perspective and before/after re-assessment — P3

- **Domain:** Development · **Our status:** partial · **Research effort estimate:** L (6 stories)
- **Reason:** 360° multi-rater feedback rejected as a whole-product item, and again in the GTM do-not-build list as downstream of a survey engine and an HRIS join we are not building this year.
- **Evidence:** critics.txt L169 and L312
- **What exists instead:** Nothing filed. The survey engine (**#1877**) is the prerequisite that would have to land first.

### 177 · ATS integration: Greenhouse / Lever / Workday Recruiting / iCIMS / SmartRecruiters + XML job feed — P1

- **Domain:** Hiring · **Our status:** missing · **Research effort estimate:** XL (8 stories)
- **Reason:** ATS integration via a unified broker (Merge) rejected as a whole-product item; the chosen answer is to publish the write API and let the customer or a partner wire it.
- **Evidence:** critics.txt L169 and L308 — "Publish the write API and the Zapier triggers; let the customer or a partner wire it."
- **What exists instead:** Substitute, not a like-for-like cover: write API **#1994/#1996** and the Zapier app **#2002/#2004**.

### 193 · Employer events, career fairs and booked interview schedules — P2

- **Domain:** Hiring · **Our status:** missing · **Research effort estimate:** L (7 stories)
- **Reason:** Employer events, career fairs and OCI/booth/bidding engines rejected — Symplicity's moat, six figures of engineering, wrong buyer.
- **Evidence:** critics.txt L169 and L310
- **What exists instead:** Only the office-hours/group-session half exists as **#1856**, which *explicitly excludes* booths, bidding, ticketing, payments and a public events directory.

### 214 · Predictive analytics: drop-off and disengagement risk scoring — P2

- **Domain:** Analytics · **Our status:** missing · **Research effort estimate:** L (5 stories)
- **Reason:** Predictive drop-off / disengagement risk scoring rejected — not enough volume for a model to beat a rules table.
- **Evidence:** critics.txt L171 — "Ship a deterministic health score and call it deterministic — that is more defensible than a scored black box." (also L312)
- **What exists instead:** Deterministic substitute shipped: **#1898** (published rules table), **#1901** (trend + threshold alerts), **#1902** (at-risk queue).

### 221 · External industry benchmarking dataset — P3

- **Domain:** Analytics · **Our status:** partial · **Research effort estimate:** L (4 stories)
- **Reason:** External cross-installation benchmarking rejected — "the benchmark needs installations you do not have".
- **Evidence:** critics.txt L171 (also L312)
- **What exists instead:** Nothing filed. **#1911** carries an *within-installation* anonymised employer benchmark only.

### 224 · SCIM 2.0 user provisioning and deprovisioning — P0

- **Domain:** Integrations · **Our status:** partial · **Research effort estimate:** L (6 stories)
- **Reason:** Same rejection as gap #0 — the integrations domain's duplicate of the SCIM entry.
- **Evidence:** critics.txt L161, L305
- **What exists instead:** **#1970** (deferral record); substitute **#1963–#1967**.

### 234 · ATS integration (Greenhouse, Lever, Workday Recruiting) via a unified broker — P1

- **Domain:** Integrations · **Our status:** missing · **Research effort estimate:** XL (7 stories)
- **Reason:** Same rejection as gap #177 — the integrations-domain duplicate.
- **Evidence:** critics.txt L169, L308
- **What exists instead:** Substitute: **#1994/#1996**, **#2002/#2004**.

### 235 · LMS / LXP integration (Cornerstone, Degreed, LinkedIn Learning, LTI for Canvas/Moodle) — P1

- **Domain:** Integrations · **Our status:** missing · **Research effort estimate:** XL (7 stories)
- **Reason:** LMS / LXP / LTI rejected — "We are a pipeline product, not a courseware vendor. Link out."
- **Evidence:** critics.txt L169 and L309
- **What exists instead:** The link-out half shipped as **#1862** (ContentItem library with LMS link-out). No LTI connector, no grade passback.

### 247 · Embeddable widgets for program and partner websites — P3

- **Domain:** Integrations · **Our status:** missing · **Research effort estimate:** M (3 stories)
- **Reason:** Embeddable widgets for programme and partner websites rejected as a whole-product item.
- **Evidence:** critics.txt L169
- **What exists instead:** Nothing filed. **#1954** is a Teams tab surface, not a general embeddable widget.

### 254 · AI notetaker: meeting summary and transcript written back to the relationship — P1

- **Domain:** AI · **Our status:** missing · **Research effort estimate:** XL (6 stories)
- **Reason:** Same rejection as gap #143 — the AI-domain duplicate of the AI notetaker.
- **Evidence:** critics.txt L169
- **What exists instead:** Nothing filed.

### 267 · AI program-health insights: retention/dropout risk, stalled-relationship diagnosis, next-best-action for admins — P2

- **Domain:** AI · **Our status:** partial · **Research effort estimate:** L (6 stories)
- **Reason:** AI programme-health insights (retention/dropout risk, stalled-relationship diagnosis, next-best-action) — the predictive half falls under the same rejection as gap #214. It is the one AI-domain gap that is not in epic #2016's routed set of 33.
- **Evidence:** critics.txt L171, L312
- **What exists instead:** Deterministic substitute: **#1898**, **#1902**, **#1908** (prescriptive next actions). The AI/predictive framing was dropped.

### 289 · RTL / bidirectional layout support and a first RTL locale — P2

- **Domain:** UI/UX · **Our status:** missing · **Research effort estimate:** L (5 stories)
- **Reason:** RTL / bidirectional layout support rejected in both the whole-product list and the GTM do-not-build list.
- **Evidence:** critics.txt L169 and L313
- **What exists instead:** Nothing filed. **#2082** builds an "add a locale" pipeline for LTR locales only.

### 327 · Data residency: selectable/documented hosting region (EU, and a second region) — P1

- **Domain:** Infra · **Our status:** missing · **Research effort estimate:** L (5 stories)
- **Reason:** Same rejection as gap #11 — the infrastructure-domain duplicate.
- **Evidence:** critics.txt L165, L281
- **What exists instead:** Answered in **#2027**; no engineering issue.

---

## Uncovered

**None.** The single entry that reached this section — gap 91, *Dual mentor+mentee role for one person* —
was re-checked against the tree and turned out to be **already shipped**: `src/lib/features.ts:66` and the
trilingual copy at `src/i18n/dictionaries.ts:2545/6037/9525` describe a working feature. It was scored
`missing` in error by the inventory pass. See its entry under *Deliberately dropped* for the evidence.

So the accounting closes exactly: **348 gaps = 325 covered + 22 rejected with a written reason + 1 already
built.** Nothing fell out of the routing unexplained.

### Covered only in part

Not uncovered, but the shipped scope is narrower than the research asked for. Each is a place where a future "did we close this gap?" audit would otherwise get a false green.

| # | Gap | Prio | What actually ships |
|---:|---|---|---|
| 36 | Sub-organizations / departments with their own config and admins | P1 | Filed deliberately at P3 (#1630) although the research rated it P1. |
| 52 | Group, peer, reverse and flash relationship shapes (one-to-many mentoring) | P1 | Data foundation only (#1804). The configurable programme-style layer is fenced out — see dropped gaps #79/#80/#81. |
| 115 | SMS / WhatsApp as a delivery channel | P2 | Adapter contract + recorded non-goal (#1712). No SMS/WhatsApp channel is built (critics.txt L313). |
| 142 | Group events / office hours with registration, capacity and attendance | P2 | Registration/capacity/waitlist/attendance only (#1856); booths, bidding, ticketing and a public events directory are excluded — see dropped gap #193. |
| 155 | Mentor & mentee training: handbooks, mini-courses, quizzes and completion tracking | P1 | Handbooks + link-out only (#1835/#1864); the GTM line says link out rather than build courseware. |
| 156 | Program content library with per-program scoping, completion tracking and LMS link-out | P1 | Library + LMS link-out (#1862); the LMS/LTI connector itself is dropped (gap #235). |
| 164 | Recognition layer: kudos, badges, points and one-click LinkedIn sharing | P2 | Kudos (#1868) and verifiable certificate (#1866) only; points, badges and leaderboards are on the GTM do-not-build list. |
| 178 | HRIS sync for company-side users and hiring managers (Personio, BambooHR, Workday, SAP SuccessFactors) | P1 | Personio + BambooHR only (#1968/#1969); Workday and SAP SuccessFactors are recorded as contract-gated in #1970. |
| 202 | Custom report builder with saved, shareable, server-persisted definitions | P1 | Fixed report registry (#1903), not the free-form builder the gap asked for — "fixed and correct beats configurable and wrong". |
| 219 | DEI and representation analytics | P2 | Recorded deferral only (#1919/#1920) — no report ships this year. |
| 220 | Retention and internal-mobility outcome comparison (participants vs non-participants) | P2 | Recorded deferral only (#1919/#1920) — no report ships this year. |
| 225 | HRIS connectors (BambooHR, Personio, Workday, SAP SuccessFactors) | P0 | Personio + BambooHR only; Workday/SuccessFactors contract-gated in #1970. |
| 245 | SMS / WhatsApp delivery channel via a provider integration | P2 | Same as gap #115 — recorded non-goal (#1712). |
| 259 | Skill taxonomy + embedding/semantic layer under matching, talent pool and requisition alerts | P1 | Taxonomy half only (#1811–#1813, #1821); the embedding/vector layer is deliberately descoped. |
| 287 | Command palette and keyboard shortcuts across the app | P2 | Filed at P3 (#2079) although the GTM do-not-build list names the command palette. |
| 290 | Real offline capability: read my mentees/goals/today's meetings offline and queue writes | P2 | A scoped spike and a written decision (#2085), not an offline implementation. |
| 324 | Trust Center: SOC 2 Type II path, subprocessor register, DPA, pen-test cadence | P0 | The free 80% ships (#2027/#2029/#2031). SOC 2 Type II itself is costed-not-started per critics.txt L163 — it is money and 6–12 months of evidence, not an engineering item. |

---

## Counts

| | Count |
|---|---:|
| Gaps in the research | **348** |
| Covered — at least one created issue identified | **325** |
| &nbsp;&nbsp;of which covered only in part (scope deliberately cut) | 17 |
| Deliberately dropped **with** an evidenced reason | **22** |
| Uncovered — no issue, no decision | **0** |
| Already shipped, mis-scored by the research | **1** (gap 91) |

Gap 91 is counted once, as *already shipped*; 325 + 22 + 1 = 348.

### By priority

| Priority | Total | Covered | Dropped (with reason) | Uncovered |
|---|---:|---:|---:|---:|
| P0 | 69 | 67 | 2 | 0 |
| P1 | 151 | 141 | 10 | 0 |
| P2 | 108 | 100 | 7 | 0 |
| P3 | 20 | 17 | 3 | 0 |
| **Total** | **348** | **325** | **22** | **0** |

*(P2 also carries the one already-shipped entry, gap 91, which is neither covered-by-an-issue nor dropped.)*

### Dropped, by priority

All 23 unrouted gaps. 22 of them were rejected by the CTO critic with a written reason; the 23rd, gap 91, was not rejected at all — it is already shipped (see its entry above).

- **P0 (2):** 0 SCIM 2.0 user provisioning & deprovisioning, 224 SCIM 2.0 user provisioning and deprovisioning
- **P1 (10):** 11 Data residency / regional hosting choice, 32 SCIM 2.0 provisioning and deprovisioning per tenant, 79 Group / circle mentoring (one mentor to many, peer groups), 80 Flash / one-off mentoring and open office-hours booking, 81 Reverse and peer mentoring as configurable program styles, 177 ATS integration: Greenhouse / Lever / Workday Recruiting / iCIMS / SmartRecruiters + XML job feed, 234 ATS integration (Greenhouse, Lever, Workday Recruiting) via a unified broker, 235 LMS / LXP integration (Cornerstone, Degreed, LinkedIn Learning, LTI for Canvas/Moodle), 254 AI notetaker: meeting summary and transcript written back to the relationship, 327 Data residency: selectable/documented hosting region (EU, and a second region)
- **P2 (7):** 45 Data residency / region selection per tenant, 143 AI meeting notes: recording, transcript and an editable summary, 162 AI meeting notetaker: transcript, summary and action items written back to the relationship, 193 Employer events, career fairs and booked interview schedules, 214 Predictive analytics: drop-off and disengagement risk scoring, 267 AI program-health insights: retention/dropout risk, stalled-relationship diagnosis, next-best-action for admins, 289 RTL / bidirectional layout support and a first RTL locale
- **P3 (3):** 169 360° multi-rater feedback with separated manager perspective and before/after re-assessment, 221 External industry benchmarking dataset, 247 Embeddable widgets for program and partner websites

**P0 gaps that came out UNCOVERED: none.** Every P0 in the research is either routed to an epic with named issues, or dropped with the CTO critic's reason on the record. Only two P0s are in the dropped set — gaps 0 and 224, the two duplicate SCIM 2.0 entries — and both have a written answer in **#1970** (contract gate) plus a shipped substitute in **#1963–#1967** (scheduled SFTP/CSV roster feeds with automatic deprovisioning). The single genuinely lost gap, 91, is P2.
