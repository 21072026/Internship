# Competitive analysis — mentoring, internship and early-career hiring platforms

**Date:** 2026-08-30 · **Scope:** 16 platforms, 1 378 catalogued competitor features, 14 code-grounded
inventory domains, 348 gaps · **Tracking initiative:** [#1514](https://github.com/21072026/Internship/issues/1514)

---

## 🇹🇷 Yönetici özeti

On altı rakip platform (Together, Qooper, Chronus, MentorcliQ, Mentorgain, Guider, PushFar, Mentorloop,
Ten Thousand Coffees, Torch, Mentornity, Gravyty/Graduway, Handshake, 12twenty/Symplicity,
Riipen+Forage+Parker Dewey, Insala/Mentoring Complete kümesi) uçtan uca incelendi. Rakiplerin **1 378
özelliği** kataloglandı, kendi kod tabanımızın **14 domainde envanteri** `file:line` kanıtıyla çıkarıldı ve
**348 boşluk** önceliklendirildi (69 × P0, 151 × P1, 108 × P2, 20 × P3; toplam ≈1 659 story puanı).

**Önemli olan üç bulgu:**

1. **Özellik olarak geride değiliz — *satılabilirlik* olarak geriyiz.** Kod tabanı 88 Prisma modeli,
   ~300 API operasyonu, 353 dosyalık Playwright paketi ve 3 490 × 3 dilde CI ile doğrulanan bir sözlük
   taşıyor. Eksik olan özellik değil; ikinci bir müşteriye satmayı *güvenli* kılan katman: kiracı
   izolasyonunun açılması (`MT_ENFORCE_ISOLATION` bugün kapalı), gerçek bir yetki modeli (tek bir `ADMIN`
   rolü var ve herhangi bir kiracı yöneticisi başka bir kiracının SAML sertifikasını değiştirebiliyor),
   tek bir faturalama öznesi ve incelenebilir şema migrasyonları (`db push --accept-data-loss` hâlâ
   deploy yolunda).
2. **Kurumsal mentorluk kontrol listesi bir tuzak.** SCIM + HRIS + LMS + Teams + SOC 2 + çok bölgeli
   barındırma, on yıllık bir başlangıç avantajına sahip rakiplere karşı 20 mühendislik yılı demek.
   Kazanamayacağımız RFP'leri kazandıran maddeleri bilinçli olarak *almıyoruz*.
3. **Savunulabilir konum, 16 satıcının hiçbirinin modellemediği şey:** mentee → staj → işe alım hunisi.
   13 aşamalı, kiracıya özel yapılandırılabilir pipeline; aşama bazlı SLA; çıkış nedeni taksonomisi;
   gerçek aşama bekleme süresi; **Berichtsheft/haftalık staj raporu** onay akışı; kör puanlamalı mülakat
   panelleri ve bir teklif durum makinesi. Rakip dokümanlarının ve incelemelerinin kendi ifadesiyle:
   mentorluk satıcıları "gelişimde durur", deneyimsel öğrenme pazar yerleri ise "projede durur".

**Fiyatlandırma bulgusu — pazarlama silahımız:** 16 satıcıdan yalnızca **3'ü** (MentorcliQ, Mentorloop,
Mentornity) kendi fiyat sayfasında kullanılabilir bir rakam yayımlıyor. Kalan 13'ü her alıcıyı bir demo
görüşmesine yönlendiriyor; kategorinin bilinen giriş noktası ~9 900–15 000 USD/yıl ve çoğunda ne ücretsiz
sürüm ne de deneme var. **Yayımlanmış EUR fiyat + self-servis satın alma + mentor ve mentee için sonsuza
kadar ücretsiz çekirdek**, hiçbirinin kopyalayamayacağı bir konumlandırmadır. AGPL-3.0-or-later altında
self-host edilebilir olmamız da aynı yöne çalışır: 16 rakibin tümü kapalı kaynak SaaS.

**Önerilen konumlandırma:** DE/AT/CH ve TR'de 100–1 000 çalışanlı işverenlerin staj/graduate program
sorumlusu (Persona A), yerleştirme yapan kurumlar — kariyer merkezleri, dual-study koordinatörleri,
mesleki eğitim sağlayıcıları (Persona B) ve bu iki kanaldan aday alan işverenler (Persona C). Fiyatlar
yayımlanmış: Community €0 → Program €149/ay → Program Plus €399/ay → **Enterprise €749/ay (€8 988/yıl,
sayfada basılı)**. Ölçüm birimi koltuk değil **aylık aktif eşleşmiş çift**; mentor ve mentee asla
faturalanabilir bir birim değil.

**Ne YAPMAYACAĞIZ (bilinçli kayıplar):** 1. yılda SOC 2 Type II denetimi; SCIM 2.0, HRIS konektörleri,
alt-organizasyonlar ve çok bölgeli veri ikametgâhı; Slack ve Microsoft Teams uygulamaları; grup/çember/
akran/ters/flash mentorluk biçimleri (`MentorshipRelation` 1:1 kalır); ATS entegrasyonları; öğrenme
içeriği, LMS/LTI ve sertifikasyon; kariyer fuarı ve OCI motorları; özel rapor oluşturucu; 360° çok
değerlendiricili geri bildirim, NPS ağırlıklı anket paketleri, öngörücü risk skorlaması; SMS/WhatsApp;
yerel iOS/Android uygulamaları; RTL. Ve **hiçbir zaman** bireysel mentor veya mentee için ücretli bir
katman — ücretsiz çekirdek pazarlamanın kendisidir.

**İlk kilometre taşı:** ikinci müşteriye fatura kesebilmek için kapatılması gereken beş güvenlik/izolasyon
maddesi (~25 story puanı). Fiyat sayfası yayına girmeden önce bunlar bitmeli, çünkü fiyat sayfası
2. kiracıyı yaratan şeydir.

---

## 1. Method and scope

### What was researched

| Input | Volume | How it was produced |
|---|---|---|
| Competitor corpus | 16 platforms, **1 378 features**, pricing, integration lists, weakness lists | Vendor pricing/product/help-centre pages, public docs, review-site evidence (Capterra, G2, GetApp, TrustRadius), UK G-Cloud filings, third-party pricing analyses |
| Our inventory | 14 domains, 609 `full` + 75 `partial` + 11 `stub` capabilities | Read directly from this repository with `file:line` evidence for every entry |
| Gap set | **348 gaps**, each with priority, effort, story count, our status, and which competitors have it | Competitor corpus × inventory, deduplicated per domain |
| Critic passes | 3 (completeness, CTO sequencing/risk/leverage, go-to-market personas and pricing) | Independent adversarial reviews of the gap set |

Feature counts per vendor range from 53 (Mentorgain) to 126 (Mentorloop); integration lists from 10
(Mentorgain) to 40 (Graduway). A `*` in the corpus marks a feature judged to be a headline or
differentiating capability rather than table stakes.

### Source article

The pricing survey started from
<https://www.mentorgain.com/blog/mentoring-platform-pricing-comparison> and was then verified
vendor-by-vendor against each vendor's own pricing page, help centre and third-party listings. Where the
article, the vendor and a directory disagree, the document below says so rather than picking one.

### Honesty rules applied

- Every claim about **us** carries a `file:line` reference into this repository.
- Every claim about **them** is attributed to the vendor's own page, their documentation, or a review
  site — third-party estimates are labelled as unverified.
- Where a vendor's own pages contradict each other (Mentorgain's SOC 2 status; Together's mobile app),
  the contradiction is recorded, not resolved.
- "No competitor has X" means: X does not appear anywhere in the 1 378-feature corpus.

### What was *not* researched

Not covered: general ATSs (Greenhouse, Lever, Workday Recruiting), HRIS suites, generic LMSs,
consumer mentoring marketplaces (MentorCruise, ADPList), and regional job boards. They compete for
adjacent budget but none of them models a mentor↔mentee relationship.

---

## 2. The market

### 2.1 Published pricing across all 16 platforms

| # | Platform | Category | Published price? | Entry point (as published or reported) | Metering unit | Free tier / trial |
|---|---|---|---|---|---|---|
| 1 | Together Platform | Enterprise mentoring | ❌ No | ~$10k/yr reported by third parties; $6/user/mo on SoftwareSuggest (unconfirmed) | Actively **matched participants**, not seats | None / none |
| 2 | Qooper | Enterprise mentoring | ❌ No | $10 000/yr (Capterra); $15–25k/yr above ~1 000 participants | Usage-based, annual commitment | None / none |
| 3 | Chronus | Enterprise mentoring | ❌ No | Three named tiers, all "Contact Us for Pricing"; Ignite Performance capped at 300 licences and **1 program** | Licences + program count | None / unconfirmed |
| 4 | MentorcliQ | Enterprise mentoring | ✅ **Yes** | **$9 900/yr** for 100 employees (~$99/employee/yr) | Employees / seats | None / none |
| 5 | Mentorgain | Mid-market mentoring (India/APAC) | 🟡 Blog only | ₹3.8L/yr (~$4 000) up to 100 users; ~$6 700 to 250; ~$9 000 to 500 | **Organisation-level bands**, not per-user | None / claimed only by aggregators |
| 6 | Guider | Enterprise mentoring | ❌ No | Lite (≤250 users, 90-day rolling) / Pro / Enterprise, bespoke proposal | Users licensed; unlimited relationships inside the licence | None / none |
| 7 | PushFar | Mentoring + open network | ❌ No | ~$200/mo reported (unverified secondary source) | Annual platform licence per organisation | Free for individuals; **no org trial** |
| 8 | Mentorloop | SMB→mid-market mentoring | ✅ **Yes** | **From $299/mo** (Pro); Enterprise quote-only | Participant bands (table unpublished) | Free build/demo mode, no card |
| 9 | Ten Thousand Coffees | Enterprise talent networking | ❌ No | Standard / Extended, "Get a Quote" | Employees (≤5 000 vs >5 000); **all features in every plan**, tiers differ only on service | None / none |
| 10 | Torch | Executive coaching | ❌ No | ~$500/user/mo (~$6 000/user/yr) reported | Coachee seats, 3/6/12-month engagements | None / none |
| 11 | Mentornity | SMB mentoring | ✅ **Yes** | **Free ≤10 users, all features**; paid from **$289/mo**; ~$299 per 1 000 users at volume | **Active participants** the org itself designates | Free plan, no expiry, no card |
| 12 | Gravyty / Graduway | Alumni community + mentoring | ❌ No | ~$200–500/mo small; $1–2.5k/mo mid; $5–15k+/mo large (third-party, unconfirmed) | Institution size + bundled modules | None / none |
| 13 | Handshake | Early-career job marketplace | ✅ Employer side | Basic **free**; Pro **$450/mo**; Enterprise quote | Employer seats, messages, campaigns | Free employer tier |
| 14 | 12twenty + Symplicity | Career-services suite | 🟡 UK G-Cloud only | Symplicity CSM **£16 600/yr** (0–1 000 FTE) rising to **£127 700** (50–75k FTE); 12twenty quote-only | Student FTE bands + per-module line items + **AI service credits** | None / none |
| 15 | Riipen + Forage + Parker Dewey | Experiential learning / micro-internships | 🟡 Parker Dewey only | Pilot **$5 000 one-off**; Parker Dewey+ **$7 500/yr**; Team **$15 000/yr** | Projects per year | Riipen educator side free |
| 16 | Insala / Mentoring Complete / Wisdom Share / Xinspire | Legacy mid-market mentoring | 🟡 Mentoring Complete only | **$5 000/yr** (25 matches, 1 program) → $10k → $15k → $25k | **Matches** and concurrent **programs** | None / none |

### 2.2 The observation that matters

**Only 3 of 16 put a usable price on their own pricing page** — MentorcliQ ($9 900/yr), Mentorloop
($299/mo) and Mentornity ($289/mo plus a genuinely free 10-user plan). The other **13 route every buyer
into a demo call**. Three more publish *somewhere* but not on their pricing page: Mentorgain's numbers
live in a blog post while `/pricing` is a contact form; Symplicity's tiers are visible only because a UK
G-Cloud framework filing forced them into the open; Parker Dewey and Mentoring Complete publish, but both
are adjacent-category products.

Three structural consequences fall out of that:

1. **Evaluation is slow and gated.** Together, Qooper, Chronus, MentorcliQ, 10KC, Guider and PushFar all
   ship *no free version and no free trial* — a prospect literally cannot see the product without a
   salesperson. Only Mentorloop and Mentornity let someone touch the product unaccompanied.
2. **The metering unit is the participant.** Together bills actively matched users; Mentornity bills
   active participants; MentorcliQ bills employees; Mentoring Complete bills matches; Mentorloop bills
   participant bands. In every case, *growing the program costs the buyer money* — which is exactly
   backwards for a program owner trying to increase participation.
3. **The floor is high.** The cheapest credible enterprise mentoring entry point in the set is
   $5 000–$10 000/year. Nothing in the category serves a 100-person employer running 40 interns with a
   €3–15k discretionary budget and no procurement gauntlet.

Our wedge is the exact inverse of all three: **published EUR prices, self-serve checkout, and a free core
that is never metered on mentors or mentees.**

---

## 3. Per-competitor profiles

### 3.1 Together Platform

- **Positioning:** enterprise mentoring for HR/L&D, now owned by and natively embedded in Absorb LMS
  (launched Oct 2025). Sells on program templates, matching quality and ROI reporting.
- **Pricing:** quote-only. Billed on *actively matched, participating users* rather than headcount; "no
  hidden costs — implementation, support, and no initiation fees". Third parties put the entry point
  near $10k/yr. 92 catalogued features, 29 integrations.
- **Headline capabilities:** weighted-criteria matching with hard exclusion rules (never pair a direct
  report); five matching processes including roulette/speed matching on an admin cadence; Development
  Programs as a blended-learning container; program templates shipping pre-loaded with agendas, tasks,
  emails and promo assets; Match Health Monitor flagging pairs that are not meeting; a fully embedded
  Microsoft Teams app with DM delivery and SSO passthrough; SCIM 2.0 provisioning plus a Reports API;
  AI personalised session agendas, AI profile generation from LinkedIn/CV, an AI program builder, and AI
  PII redaction with a global kill switch; WCAG 2.1 AA with a completed VPAT; SOC 2 Type II.
- **Known weaknesses:** calendar/scheduling is the single most repeated complaint — trouble changing a
  meeting time after scheduling, wrong-timezone invites, duplicate events, Outlook confusion. In
  "Free/Busy Only" mode video links are silently *not* attached. Reporting is hard to pull and hard to
  customise. Workflows read as rigid. **No secure file sharing** — reviewers cannot move a Word or
  PowerPoint document into the platform. No AI notetaker. Mobile app presence is inconsistent (a help-
  centre app exists, yet 2026 reviewers still ask for one). Localisation is **Enterprise-only and priced
  per language**, with human translation extra.

### 3.2 Qooper

- **Positioning:** mentoring, coaching and ERG programs with a heavy AI story ("People Intelligence").
  88 features, 33 integrations.
- **Pricing:** quote-only; $10 000/yr on Capterra, $15–25k/yr above 1 000 participants, annual
  commitment standard. No free version, no free trial.
- **Headline capabilities:** weighted matching on a 1–10 scale with a profile-form builder feeding the
  algorithm; Bulk Suggest for mass matching; Program Steps — a configurable relationship journey with
  drip publishing triggers; nine supported program types; deep-link and six-digit access-code enrolment;
  custom lesson authoring plus a curated training library with stuck-learner detection; groups, circles
  and cohorts; a Snowflake data-warehouse integration; ROI dashboard and calculator; Qooper Insights
  (retention risk and career-movement signals); native iOS and Android apps; ERG management with budget
  and expense approval.
- **Known weaknesses:** pricing is opaque and reviewers say so. Key configuration is **not self-serve** —
  conditional matching rules and manager emails must be requested from the CSM. "Limited customization"
  is the most repeated review complaint. Messaging is weak: **cannot attach a PDF, cannot insert a link,
  cannot send multi-line messages, no message editing.** In-app video drops calls. Mobile app "lacks
  flexibility of the desktop version" and cannot schedule a meeting. Goals are tied to tags rather than
  to program steps, so progress cannot be tracked against the journey.

### 3.3 Chronus

- **Positioning:** the incumbent enterprise mentoring platform; strongest public-sector credentials in
  the set (FedRAMP Moderate, DoD CC IL4). 92 features, 35 integrations.
- **Pricing:** quote-only across three named licence tiers. **Ignite Performance is capped at 300
  licences and one program** — program count is an explicit paywall lever.
- **Headline capabilities:** MatchIQ matching engine with four configurable modes; Mentoring Circles with
  a self-service marketplace; flash mentoring; a program-format configurator (structure × timeframe ×
  style); Guided Conversations and an expert meeting-guide library; video profiles; Rumi, an AI mentor
  with a documented AI-to-human handoff; Purpose Assessment feeding matching; Connection Communities as
  a whole ERG product line; Change Adoption programs; executive dashboards and real-time engagement
  alerts; full experience embedded in Slack *and* Teams; data residency across three regions; **18-language
  localisation**; Managed Services (outsourced program administration).
- **Known weaknesses:** dated UI is the most repeated complaint — verbatim, *"the site and app feels like
  I am in 2008"*. Navigation "sends you in circles". Matching is criticised as shallow: MatchIQ matches
  on preset fields and does not analyse open-text goals, so the AI branding outruns the mechanism.
  Reporting is inconsistent and needs export to be useful. Global admins must route even minor
  configuration through Chronus. Integration setup is repeatedly described as painful, and
  **Outlook email replies do not route back into the platform**. Notifications are delayed.

### 3.4 MentorcliQ

- **Positioning:** mentoring plus ERG/community (CommunityCliQ), sold hard on ROI proof. 90 features,
  20 integrations.
- **Pricing:** **published** — CliQ Start from **$9 900/yr for 100 employees**, then CliQ Plus and CliQ
  Complete on quote. No free trial, no free version.
- **Headline capabilities:** Smart Match, a Gale-Shapley-based optimiser that solves for the globally
  best set of pairings rather than matching sequentially; three matching styles (Admin / Suggested /
  Self) with numeric compatibility scores; the Visual Personality Survey, an image-based instrument
  claimed to produce 58 % more compatible matches; AI Launch program design and both admin- and
  participant-facing AI assistants; mentoring partnership agreements and closure plans; QuickcliQ pulse
  surveys; an award-winning ROI dashboard with participant-vs-non-participant retention comparison and
  promotion/internal-mobility tracking; the RISE industry benchmarking report; ERG budget management;
  WCAG 2.1 AA; TX-RAMP Level 1.
- **Known weaknesses:** reporting is not sortable or searchable in-app — users download everything.
  **Full ROI reporting is paywalled behind both a higher tier and a completed HRIS integration** — the
  headline proof mechanic is not in the price you are quoted. UI is cluttered and dated. **The mentorship
  agreement is signed outside the app** — no embedded e-signature. Task reminders are too weak. All
  scheduling pressure falls on the mentee by design. On-demand education issues no completion
  certificate. **Multi-language and the mobile app are withheld from the entry tier.**

### 3.5 Mentorgain

- **Positioning:** India/APAC-first mid-market mentoring with an AI assistant ("AI Buddy") as the
  centrepiece. 53 features, 10 integrations — the smallest surface in the set.
- **Pricing:** published in their own blog (₹3.8L → ₹8.6L/yr by user band, ~$4 000 → $9 000),
  **organisation-level, not per-user**, implementation included, no per-session charges — but the
  `/pricing` page itself is a gated contact form.
- **Headline capabilities:** three switchable matching modes; goal-gated journey lifecycle; offline /
  retroactive session logging; **dormant-pair detection with automated nudges** (the only vendor in the
  set with an explicit dormancy mechanic); AI Buddy as a 24/7 org-trained assistant with mentor routing,
  a knowledge-base enrichment loop and between-session coaching nudges; data migration from spreadsheets
  or an incumbent; a 1–2 week guided implementation; a Mentorship Readiness Diagnostic.
- **Known weaknesses:** vendor-admitted small customer base — 2 case studies, 3 Capterra reviews, 1 G2
  review. Vendor-admitted "fewer third-party integrations": **no named HRIS, no LMS, no SCIM, no
  webhooks, no Zapier, no public API documentation anywhere.** Native mobile app "still in the pipeline".
  **SOC 2 status contradicts itself across their own pages** ("in process" on the security page vs
  "certified" in the FAQ). Three mutually contradictory price models circulate on directories.
  **English only**, no accessibility statement.

### 3.6 Guider

- **Positioning:** UK-based mentoring optimised for onboarding and DEI, Microsoft-first. 60 features,
  25 integrations.
- **Pricing:** quote-only. Lite (≤250 users, 90-day rolling) / Pro (annual, unlimited users) /
  Enterprise. The licence meters **users**, and relationships inside the licence are unlimited. A bespoke
  "Pricing Proposal" is built per customer.
- **Headline capabilities:** AI matching with three modes; skills-based pairing (skills sought vs skills
  offered); **cross-company / multi-organisation mentoring**; packaged programme templates with session
  resources; an internal marketing and comms toolkit; SMART goal setting and sharing; a Learning Hub;
  real-time BI dashboard with skills-gap analysis and DEI/ERG segmentation; a native Microsoft Teams app
  carrying the full platform; white-labelling; a dedicated CSM on every plan.
- **Known weaknesses:** scheduling is a recurring pain point and the flow degrades if either party
  declines calendar sync. **No Apple/iCloud calendar.** Built-in video "has moments of instability or
  simply will not work". Messaging lags cross-region. Admin depth is thin — one customer reports a
  dedicated administrator profile was "not yet enabled". Matching customisation is delivered through the
  CSM, not by the admin. **No published SOC 2 Type II or ISO 27001**, and no evidence of SCIM.

### 3.7 PushFar

- **Positioning:** organisational mentoring software *plus* an open volunteer mentor network of
  50 000–75 000 people — the only vendor whose supply is not bounded by the customer's own headcount.
  93 features, 30 integrations.
- **Pricing:** no public price anywhere; annual platform licence per organisation instance, quoted by an
  account manager. Free for individuals; **explicitly no free trial for organisations.**
- **Headline capabilities:** three-mode matching with admin-configurable categories and custom rules on
  custom fields; a dismiss-and-learn feedback loop; unlimited parallel programmes; Pause / Lock / Taking
  a Break relationship states; organisation-ID account migration; built-in video and phone calling;
  automated nudge and reminder emails; networking permissions outside relationships; PushFar Points
  gamification with a leaderboard; a resources catalogue with one-click publish; safeguarding
  (keyword detection); multilingual participant experience; 24–48 hour instance provisioning.
- **Known weaknesses:** UI/navigation is repeatedly called unintuitive. **Mentoring requests auto-expire
  after 9 days and an expired request cannot be reinstated** — reviewers say this happens often.
  Phraseology changes are platform-wide only and cannot vary per programme. **You cannot email an
  individual user from the admin panel** — bulk sends only. Calendar integration is admin-enabled only;
  participants cannot connect their own. Mixed Microsoft 365 + Google estates give "reduced
  functionality". Adding a registration question after launch does not prompt existing users. Only two
  programme shapes exist.

### 3.8 Mentorloop

- **Positioning:** the most self-serve, most product-led vendor in the mentoring set, and the one whose
  documentation is best. **126 features — the largest catalogued surface**, 37 integrations.
- **Pricing:** **published model.** Free build/demo mode with synthetic data and no card; **Pro from
  $299/month** subscribed in-app; Enterprise quote-only, ~12-month commitment, 30-day cancellation.
- **Headline capabilities:** Smart Match, a cohort-wide optimiser evaluating ~500 000 pairings "in
  seconds" so late registrants do not get leftovers; Match Tuner, a weighted rule builder with
  low-priority → required scaling; **AI free-text matching over bios, goals and aspirations** with an
  AI-generated rationale per match; draft matches with review/approve/dismiss and bulk approval; Program
  Builder, a three-step self-serve setup wizard; Program Themes; the Mentoring Bench (a talent pool of
  benched participants); an **AI notetaker** producing meeting summaries and transcripts; Coco, an AI
  program-coordination assistant; AI governance controls with a program-level kill switch and a no-model-
  training commitment; Sentiment, a continuous in-the-moment feedback feed; Milestones; Nudges; Kudos;
  SCIM 2.0 deprovisioning.
- **Known weaknesses:** **the headline differentiator is invisible at the advertised price** — Smart
  Match, the Match Tuner and matching-on-demand are Enterprise-only; Pro buyers get manual/self/blended.
  Pro is capped at **one Program Coordinator**. **The Pro signup form cannot be changed after launch.**
  Pro survey questions are not editable at all — pick 5 from a fixed bank. Running more than one program
  is a paid add-on, and the multi-program dashboards are Enterprise. Their own accessibility statement
  admits **only "partially compliant" with WCAG 2.2 AA, with named open defects** (contrast, focus
  indicators, unlabelled form fields).

### 3.9 Ten Thousand Coffees

- **Positioning:** enterprise talent networking rather than 1:1 mentoring — Introductions, Office Hours
  and Pathways. 105 features, 24 integrations.
- **Pricing:** quote-only, two plans. Notably, **all product features are in every plan** — the tiers
  differ only on implementation services and SLA. No free trial.
- **Headline capabilities:** Smart-Matching for Introductions with Column A ↔ Column B segment rules,
  required-vs-preferred (hard vs soft) rules and a manager exclusion rule; opt-in clean-up that
  auto-prunes disengaged members; auto-enrolment by profile segment; Office Hours (leader/SME-hosted
  group events) with advance question collection; Pathways bundling multiple experiences into a journey;
  an Impact Dashboard with four talent-outcome scores; cross-customer benchmarking; a tenant/hub
  multi-tenancy model; five administrator permission levels; a custom branded sending domain; SCIM 2.0;
  WCAG 2.1 AA; five languages; an academic/schools edition; **notification blackout dates**.
- **Known weaknesses:** **no mobile app at all.** No native Zoom or Webex — links are pasted manually.
  Development Programs are absent from the Slack app. **Email sender identity cannot be an internal
  person** — only the domain can be branded. "Too many email notifications" recurs. Onboarding data lift
  is heavy and both sync paths need a customer-maintained mapping spreadsheet. Without integrations wired
  up, the low-admin promise collapses. Impact scores come from a weighted survey formula that is not
  self-explanatory.

### 3.10 Torch

- **Positioning:** executive and leadership **coaching**, not mentoring — despite the Everwise heritage.
  89 features, 30 integrations.
- **Pricing:** quote-only; ~$500/user/month reported. Engagements sold in fixed 3/6/12-month durations.
  Spark AI exists as a standalone SKU without live coaching.
- **Headline capabilities:** algorithm-plus-human Match Team hybrid matching over a curated ~350-coach
  marketplace with sliding-scale style preferences; Workspaces for data partitioning; Path sections with
  timed release and role visibility; partnership pause and resume; a rules-based admin action-item
  engine; a leadership capacities framework; late-cancel and no-show accounting; a manager alignment
  meeting with an **off-platform guest link**; Spark AI as an always-on coaching agent grounded in
  organisational context, with **voice role-play simulations** and after-action reports; Torch 360
  feedback with a separated manager perspective, hidden strengths/opportunities and impact
  re-assessment; **NLP name-scrubbing on written feedback**; **privacy minimum-response thresholds**;
  post-deactivation anonymisation and synonymized accounts.
- **Known weaknesses:** **mentoring is effectively gone from the product** — no mentor/mentee matching,
  no peer/reverse/flash/circle formats, no internal mentor marketplace. No SCIM and **no just-in-time
  SAML provisioning** — every participant must be pre-assigned in the IdP. Very thin integrations: Slack,
  Zoom and SAML only, **no calendar sync** (only `.ics` attachments), no public API docs. Coach matching
  is the most repeated complaint: 3–4 options, thin profiles, no video intros, no chemistry session.
  **Rematching requires a support ticket** and 1–2 business days. Heavy dependence on Torch staff for
  pausing, reactivation, SSO configuration and ROI analysis.

### 3.11 Mentornity

- **Positioning:** SMB/education mentoring with the most buyer-friendly commercial model in the set.
  63 features, 19 integrations.
- **Pricing:** **published.** Free plan: $0, up to 10 users, **all features**, no expiry, no card. Paid
  from **$289/month**, no setup fee, priced on **active participants the organisation itself designates**
  — a deliberate lever against paying for churned users. Administrators are free. Universities get a
  permanent 50 % discount.
- **Headline capabilities:** weighted rule-based matching with mandatory deal-breaker rules, a
  side-by-side comparison modal and chain re-matching optimisation; program cloning for the next cohort;
  a structured session plan with date windows and pre/post-meeting forms per session; a Coordination
  Center with per-match coordinators; mentor availability slots with two-way Google and Outlook sync and
  booking guardrails; Super Reminders (behaviour-triggered nudges); **35+ localized notification email
  types**; an in-app support desk on a Kanban board; a Program Health dashboard across 11 dimensions;
  auto-issued certificates with public verification; white-label branding.
- **Known weaknesses:** **no public REST API, no webhooks, no Zapier**; the integration list is
  essentially calendar + video + SAML. **No HRIS, no SCIM, no LMS.** No Slack or Teams bot. **No
  published security certifications at all** — no SOC 2, no ISO 27001, no trust centre. Built-in Jitsi
  video described as "faulty". Google Calendar sync unreliable. **No in-product user documentation** —
  reviewers had to send people to the company blog. Poor Android UX. No peer-to-peer meeting space and
  no flash or reverse mentoring modes. SAML is a paid add-on.

### 3.12 Gravyty / Graduway

- **Positioning:** alumni community and engagement for education, with mentoring as one module inside a
  larger Gravyty bundle. 91 features, 40 integrations — the largest integration list in the set.
- **Pricing:** quote-only, "custom pricing based on institution size and alumni community scope".
  Third-party estimates run $200–500/mo (small) to $5–15k+/mo (large), with a realistic floor near
  $5 000/yr.
- **Headline capabilities:** weighted matching per program with three modes and relationship limits;
  formal and flash mentoring, multi-site programs, program start/end dates with auto-termination;
  program-owner vs platform-admin permission split; milestone-driven automated reminders with pre-set
  discussion topics; multi-channel check-in delivery; in-platform video chat; a **safeguarding report on
  member interactions**; CASE Alumni Engagement Metrics dashboards; a branded white-label community
  portal with member-customizable homepage widgets; Premium Groups; **a jobs and internships board**;
  personalised video messaging (Gratavid) with trigger-based automations; omnichannel outreach; a no-code
  flow builder; LinkedIn profile prefill; native mobile apps; an embedded giving widget; Salesforce
  integration with field mapping.
- **Known weaknesses:** analytics is the lowest-rated area (GetApp 3.0/5) — email open rates, bounces and
  unsubscribes are not natively visible. Admins have a "real lack of control over profiles". No alert
  when someone replies to a post. Fixed homepage layout, no post categories/tags. **Thin multi-language
  coverage** and an English-only iOS app. No cross-posting out to LinkedIn. The iOS app sits at 2.7/5
  from 38 ratings with a last public update in Feb 2024.

### 3.13 Handshake

- **Positioning:** the dominant US early-career job marketplace — students, universities and employers.
  Not a mentoring product. 78 features, 39 integrations.
- **Pricing:** **employer side published** — Basic free, Pro $450/month, Enterprise on request.
  Institution side quote-based.
- **Headline capabilities:** AI talent matches and an ideal-candidate profile derived from the job
  posting; Automated Outreach and dynamic campaign audience ramping; AI-assisted messaging and applicant
  review signals; virtual career fairs with 1:1 and group session scheduling and per-session
  qualification gates; on-campus interview schedules; **Experiences — internship tracking with
  multi-party approval and custom request/approval/evaluation surveys**; Journeys; First Destination
  Survey; employer relationship management; job approval workflows; **employer trust scores, Sift and
  Google WebRisk verification**; an SIS student data importer; ATS integrations via Merge; Handshake
  Insights with peer benchmarking; Sidekick (AI résumé optimiser); student privacy tiers.
- **Known weaknesses:** **no mentoring product at all** — no matching, no program lifecycle, no session
  agendas, no relationship goals. Reported billing problems: charges continuing after cancellation,
  weekly per-job charges on closed jobs, a Feb 2025 pricing change with under 30 days' notice, email-only
  cancellation. Unpredictable renewal pricing. **A sharp cliff between free and enterprise** with no real
  mid-range. Poor interoperability — the EDU API is read-only, partner-gated, and covers only 30 days of
  expired postings. No public webhooks, no SCIM, no Zapier. Persistent scam-posting problems.

### 3.14 12twenty + Symplicity

- **Positioning:** the incumbent career-services suite for universities — the closest thing in the set to
  our Persona B buyer, at six-figure prices. 94 features, 39 integrations.
- **Pricing:** **partially published** via UK G-Cloud: £16 600/yr (0–1 000 student FTE) rising to
  £127 700 (50–75k FTE), with modules as separate line items and **AI metered through "service credits"**
  whose allowance and rate are unpublished.
- **Headline capabilities:** an on-campus-interview scheduling engine with points-based bidding and a
  multi-school interview hub; career fair management (in-person, virtual, hybrid) with interactive booth
  maps and employer self-service kiosks; AI appointment transcription; a first-destination outcome survey
  engine with survey-on-login prompts and one-click compliance reporting; JobIQ salary and offer-timing
  intelligence; **experiential learning approval workflows with conditional forms, placement ranking and
  auto-cascade**; **internship legal agreements and local compliance**; Pathways development plans and a
  skills framework; AI résumé review, AI mock interviews, and Cosmo, an in-product assistant for staff,
  on **private AI infrastructure**; an employer relationship CRM with email open/click tracking; mentorship
  matching; multi-region hosting.
- **Known weaknesses:** heavy configuration burden — reviewers say it "asks for a meaningful investment in
  configuration, administration and change management, which not every institution is positioned to make",
  and effectively requires a dedicated product owner. Long implementations. **Dated student-facing UX**
  (12twenty ease-of-use 3.0/5 vs 4.0 overall). **Not API-first** — no webhooks, no Zapier, no public
  rate-limit or schema docs. SSO beyond the standard path is chargeable. **Opaque AI cost model.** Key
  modules (OCI lottery and bidding) are paid add-ons.

### 3.15 Riipen + Forage + Parker Dewey

- **Positioning:** experiential learning and micro-internships — a learner is matched to a *project*, not
  to a person. 79 features, 34 integrations across the three.
- **Pricing:** **Parker Dewey published** — Pilot $5 000 one-off (10 projects), Parker Dewey+ $7 500/yr
  (15), Team $15 000/yr (30), Enterprise custom.
- **Headline capabilities:** open and private two-sided project/experience marketplaces with a
  recommendation engine and saved-search alerts; an AI project generator from keywords; a Project Builder
  that turns a job description into a hiring audition; Experience as a cohort container with milestones,
  submissions and timelines; **work logs / time tracking**; change requests and issue flagging as
  first-class states; employer identity verification; configurable learner privacy tiers; a rubric-based
  scoring engine with AI-assisted evaluation; **LTI Advantage grade passback**; a documented **REST API
  with full CRUD and signed webhooks with retries and delivery logs** — the only vendor in the entire set
  with a real webhook product; Credly badge issuing; a competency framework with employer ratings;
  **escrow-held project payment, learner stipends, invoicing, tax document generation and dispute
  workflows**; WCAG 2.1 AA.
- **Known weaknesses:** **none of the three does mentoring at all** — no pairing, no program types, no
  goals, no session cadence; the relationship ends when the deliverable is accepted. No native mobile
  app. No Slack or Teams. No HRIS, no SCIM, no OIDC. No ATS integration in either direction. No Zapier.
  **Riipen claims no security certification of its own** — the security page lists *AWS's* attestations.
  Riipen data residency is **Canada-only**. Localisation is EN/FR only.

### 3.16 Legacy / mid-market cluster — Insala, Mentoring Complete, Wisdom Share, Xinspire

- **Positioning:** the long-tail incumbents. Mentoring Complete is the only one with public list pricing.
  85 features, 24 integrations across the cluster.
- **Pricing:** **Mentoring Complete published** — four flat annual tiers metered by **matches** and
  **concurrent programs**, not seats: Precision Matching $5 000/yr (25 matches, 1 program, one-to-one
  only, 48h support), Starter $10 000/yr (3 programs), Scale $15 000/yr (50 matches, 5 programs), top
  tier $25 000/yr where HRIS and SSO are finally bundled.
- **Headline capabilities:** Precision Matching with auto-match vs 3-step modes, a "Chemistry Quotient",
  15 configurable match options and apply-and-rank matching; perpetual vs time-constrained cohorts;
  mentoring agreement and career-plan wizards linked to competencies; email + SMS campaigns with mail
  merge; Mentoring University certification courses; 360 satisfaction surveys (participant / manager /
  peer); 50+ configurable reports and an ROI calculator; predictive people analytics with natural-language
  querying; aggregated job feeds from Indeed and LinkedIn; **internship, externship and job-shadow
  matching**; an expertise directory; mobile apps.
- **Known weaknesses:** review-site evidence was unobtainable (G2/TrustRadius 403, Capterra 404), so the
  weaknesses below come from the vendors' own sites. **No public API, no webhooks, no Zapier anywhere in
  the cluster** — Xinspire's integration story is literally "import/export". **No SCIM, no named IdP.**
  **No Slack or Teams presence at all.** **No two-way calendar sync evidenced anywhere.** Mentoring
  Complete paywalls table stakes aggressively — in-app scheduling is not in the $5k tier, chat and
  advanced analytics not until $15k, HRIS and SSO only at $25k — and metering by *matches* means a
  100-pair program does not fit any published tier. Matching accuracy claims ("90 % accurate", "99 %
  Match Satisfaction") are published with no methodology.

---

## 4. Feature-coverage matrix

Legend — **Our status:** ✅ have · 🟡 partial · ❌ missing. "Competitors with it" lists the vendors where
the capability is evidenced in the corpus; it is not exhaustive where the whole category ships it.

### 4.1 Matching and relationship shapes

| Capability | Competitors with it | Our status | Evidence |
|---|---|---|---|
| Algorithmic matching with admin-configurable weighted criteria | Together, Qooper, Chronus, MentorcliQ, Mentorloop, Guider, PushFar, Mentornity, Graduway, Mentoring Complete | 🟡 rule-based skill overlap + load rank, no weights, no hard rules | `src/app/api/admin/mentor-suggest/route.ts:71-108`, `src/lib/matching.ts:28-43` |
| Hard rules and exclusions (never pair a direct report, timezone constraints) | Together, 10KC, Mentornity, Mentorloop | ❌ | — |
| Bulk / cohort-wide matching in one pass | MentorcliQ (Smart Match), Mentorloop (Smart Match), Qooper (Bulk Suggest), Together (Auto-Matching), 10KC | ❌ | — |
| Draft matches with review, lock and bulk approve | Mentorloop, Together, MentorcliQ | 🟡 per-request approve queue only | `src/components/admin/MentorshipRequestQueue.tsx:58,92` |
| Explainable match score shown to the decision-maker | MentorcliQ, Together, Mentorloop (AI rationale) | ❌ | — |
| Participant self-matching / browse and request a mentor | Together, Qooper, Chronus, MentorcliQ, Mentorloop, PushFar, Guider, Graduway | 🟡 consent-gated directory exists, **no "Request this mentor" CTA** | `src/app/mentors/page.tsx:200-206`, `src/components/MentorshipRequestPanel.tsx:154-158` |
| Mentor capacity limits enforced at intake, not just in the algorithm | Together, Qooper, Graduway, Mentorloop | ✅ binding gate that closes the public apply link | `src/lib/mentorAvailability.ts:44-66`, `src/app/api/apply/route.ts:20-35,74-81` |
| Consent as the basis for mentor visibility (double opt-in) | none | ✅ | `src/app/api/mentors/route.ts:37-64` |
| Re-match / change-mentor flow | Together, Mentorloop, Mentornity (chain re-match), Torch (via ticket) | ❌ | — |
| Group / circle / peer / reverse / flash program shapes | Together, Chronus, Qooper, MentorcliQ, Guider, PushFar, Mentorloop, Graduway | ❌ **deliberate non-goal** | — |
| Personality / psychometric assessment feeding the match | Chronus (Purpose Assessment), MentorcliQ (Visual Personality Survey), Insala, Symplicity | ❌ | — |
| Semantic / free-text AI matching over bios and goals | Mentorloop | 🟡 anonymised AI re-rank of a deterministic shortlist | `src/lib/aiMentorMatch.ts:103-108` |
| External mentor supply beyond the customer's own headcount | PushFar (50–75k volunteers) | ✅ public "become a mentor" application, no account minted | `src/app/api/mentor-applications/route.ts:39-120` |

### 4.2 Internship → hire pipeline (our lane)

| Capability | Competitors with it | Our status | Evidence |
|---|---|---|---|
| Configurable multi-stage candidate pipeline (applicant → intern → hired) | **none of 16** | ✅ 13 stages, per-tenant override, free-String storage | `prisma/schema.prisma:41-59`, `src/lib/pipeline.ts:6-20`, `src/lib/pipelineStages.ts:17-38` |
| Per-stage SLA with deadline stamping and overdue reminders | **none** (Together/Chronus nudge on session cadence only) | ✅ | `prisma/schema.prisma:176-190`, `src/lib/stageSla.ts:24-59`, `src/services/emailService.ts:1817-1868` |
| Structured drop-off reason captured at the moment of exit | **none** | ✅ 9-code whitelist, OTHER-requires-note, all write paths | `src/lib/dropoffReasons.ts:6-22`, `src/lib/stageChange.ts:20-52` |
| True stage dwell time (avg + median) from an audit trail | **none** | ✅ | `src/app/api/admin/analytics/aging/route.ts:83-152` |
| Right-censoring-aware time-to-hire that reports its population | **none** | ✅ | `src/lib/funnelKpi.ts:87-125` |
| Requisition → shortlist → interview request → panel → offer | none of the 12 mentoring vendors; partial in Handshake and Symplicity | ✅ end-to-end, but the interview loop dead-ends into email | `prisma/schema.prisma:2554`, `src/lib/offers.ts:51,90`, `src/app/api/interview-requests/[id]/route.ts:32` |
| Blind interview scorecards with calibration and divergence flags | **none** | ✅ org-level policy, never a per-reviewer toggle | `src/lib/blindReview.ts:25`, `src/lib/interviewPanel.ts:73` |
| Weekly internship report (Berichtsheft) with an approval workflow | **none** — Handshake and Symplicity approve *placements*, not diaries | ✅ workflow + printable diary; **no org-wide admin view** | `src/components/WeeklyReportsPanel.tsx:25`, gap: `src/app/api/weekly-reports/route.ts:26` |
| Mentor consent gating employer access to a candidate | **none** — Handshake and Symplicity expose the student directly | ✅ | `src/app/api/interview-requests/[id]/route.ts:32`, `src/app/api/company/talent-pool/route.ts:31-39` |
| Relationship lifecycle beyond ACTIVE/COMPLETED (pause, bench, extend, cancel) | Mentorloop (Bench), PushFar (Pause/Lock/Break), Torch (pause/resume) | ❌ | `prisma/schema.prisma:1691-1694` |
| Mentee-facing view of open roles with an apply flow | Handshake, Symplicity, Graduway (jobs board) | ❌ data model exists, no mentee screen | `src/components/PortalNav.tsx:15-29` |

### 4.3 Meetings, calendar and video

| Capability | Competitors with it | Our status | Evidence |
|---|---|---|---|
| Two-way calendar sync (Google and Outlook) | Together, Qooper, Chronus, MentorcliQ, Mentorloop, Mentornity, 10KC, Guider | 🟡 Google **write-only**, one call site, off by default; **no Outlook** | `src/app/api/meetings/route.ts:171`, `docs/google-calendar.md` |
| Reschedule, cancel or delete a meeting | all | ❌ **GET+POST only**; `removeMeeting()` has zero call sites | `src/app/api/meetings/route.ts:34,82`, `src/lib/googleCalendarSync.ts:100` |
| Mentor availability slots with mentee self-booking | Chronus, Mentornity, Qooper, Together | ✅ DST-correct expansion, exact-instant booking | `src/components/MeetingRequestsPanel.tsx:126` |
| Free/busy read and double-booking prevention | Together, Mentorloop, 10KC | ❌ | — |
| Native embedded video call | PushFar, Guider, Mentornity, Graduway — **all reported unreliable** | ✅ own JaaS/8x8 tenant, signed RS256 per participant, Jitsi fallback | `src/lib/jaas.ts:96-117`, `src/lib/meetingLink.ts:14-73` |
| Live "n people are in the room" presence | **none** | ✅ | `src/lib/upcomingMeeting.ts:186`, `src/app/api/webhooks/jaas/route.ts:88` |
| External no-account guests with their own RSVP and .ics | 10KC (event invitees) only | ✅ capped at 20, revocable | `prisma/schema.prisma:2116`, `src/lib/meetingGuests.ts:51` |
| Automatic attendance write-back into the relationship log | **none** — Qooper, PushFar and Mentorgain make participants log manually | ✅ + 2h-grace cron sweep | `src/lib/meetingAutoLog.ts:89,129` |
| Group events / office hours with registration and capacity | 10KC (Office Hours), Chronus, Symplicity, Handshake | ❌ | — |
| Bring-your-own conferencing (Zoom / Meet / Teams links) | Together, Chronus, MentorcliQ, Qooper, Mentorloop | ❌ | — |

### 4.4 Communications

| Capability | Competitors with it | Our status | Evidence |
|---|---|---|---|
| Lifecycle email automation and nudges | all 16 | ✅ 12 node-cron jobs | `src/services/emailService.ts` (12 tasks), `src/app/api/cron/route.ts:42,64-68` |
| Slack app | Together, Chronus, Qooper, MentorcliQ, Mentorloop, 10KC, Torch | ❌ **deliberate year-1 non-goal** | — |
| Microsoft Teams app (embedded tab) | Together, Chronus, Qooper, MentorcliQ, Guider | ❌ **deliberate year-1 non-goal** | — |
| Inbound email replies threading back into the product | **none** — Chronus is explicitly criticised for the opposite | ✅ HMAC reply tokens, IMAP + webhook, EN/TR/DE quote stripping | `src/lib/inboundEmail.ts`, `src/lib/replyToken.ts` |
| Message attachments, edit, reactions, read receipts | criticised as missing in Qooper and Together | ✅ magic-byte verified attachments | `src/app/api/messages/route.ts:107,338` |
| Per-user notification channel preference | Together, MentorcliQ, Riipen | 🟡 13-group email taxonomy; **push fires only for messages** | `src/lib/emailGroups.ts:22`, `src/lib/messagePush.ts:9` |
| RFC 8058 one-click unsubscribe + delivery ledger + health alerting | **none documented** | ✅ | `src/lib/unsubscribeToken.ts:5`, `prisma/schema.prisma:2453`, `src/lib/emailHealth.ts:30-47` |
| Editorial newsletter as a separate product | **none** | ✅ 10 curated trilingual issues, immutable once sent | `docs/newsletter.md`, `prisma/schema.prisma:917` |
| Admin-editable lifecycle email templates with preview | Together, MentorcliQ, Mentornity | ❌ templates are code | `src/services/emailService.ts` |
| SMS / WhatsApp channel | Mentoring Complete (SMS), Graduway (omnichannel) | ❌ **non-goal** | — |

### 4.5 Development, assessment and content

| Capability | Competitors with it | Our status | Evidence |
|---|---|---|---|
| Goals / development plans | all 16 | ✅ but `Goal` and `ProjectTask` are unbridged duplicates | `prisma/schema.prisma:1982`, `:1513`, `src/lib/mentorAttention.ts:60-75` |
| Session agendas and a guided conversation library | Together (AI agendas), Chronus (Guided Conversations), Qooper, Guider, 10KC, Mentoring Complete | ❌ | — |
| Program survey engine (pre/mid/post, pulse, NPS, event-triggered) | Together, Qooper, MentorcliQ (QuickcliQ), Mentorloop (Sentiment), Chronus, Riipen, Mentoring Complete | ❌ | — |
| Two-way evaluations on a per-tenant competency framework | partial in Chronus and Mentoring Complete | ✅ historical labels preserved, criteria retired not deleted | `prisma/schema.prisma:1865-1881`, `src/lib/evaluationTemplates.ts:42`, `src/lib/evaluation.ts:88` |
| Mentor-facing longitudinal scorecard of feedback received | **almost none** | ✅ overall + per-criterion averages + 6-month trend | `src/app/mentor/feedback/page.tsx:21` |
| Consent-gated testimonial publishing (author approves the exact wording) | **none** | ✅ | `src/lib/testimonials.ts:34`, `src/app/api/admin/testimonials/route.ts:11` |
| Certificates on completion | Together, Qooper, Mentornity, Riipen (Credly) | ✅ dual-signal eligibility, tenant-branded PDF | `src/lib/certificateEligibility.ts:17`, `src/app/api/mentorship/[id]/certificate/route.ts:79-88` |
| Badges, points, gamification, LinkedIn sharing | Together, Qooper, PushFar (Points), Mentorloop (Kudos), Riipen | ❌ **non-goal** | — |
| Learning content library / LMS / LTI | Together (Absorb), Chronus (Courses), Qooper, Guider, PushFar, Riipen (LTI Advantage) | ❌ **non-goal — link out** | — |
| Document requirements per stage with derived completion | **none** | ✅ + weekly missing-document nudges to both sides | `src/lib/documentRequirements.ts:85`, `src/services/emailService.ts:2825` |
| AI meeting notetaker (transcript, summary, action items) | Mentorloop, Symplicity | ❌ **non-goal** | — |

### 4.6 Analytics and reporting

| Capability | Competitors with it | Our status | Evidence |
|---|---|---|---|
| Program dashboard, funnel counts and exports | all 16 | ✅ 5 admin routes, XLSX + printable PDF report | `src/app/api/admin/analytics/funnel/route.ts:11-40`, `src/app/admin/analytics/page.tsx:161-238` |
| ROI / business-outcome reporting (cost, value, placement economics) | Together, Qooper, Chronus, MentorcliQ, Guider, Mentorgain, Mentoring Complete | ❌ **no monetary field exists anywhere in the schema** | grep across `prisma/schema.prisma` returns zero |
| Relationship health / at-risk monitor | Together (Match Health), Mentorloop, Mentornity (Program Health), Chronus | 🟡 six-signal mentor-side queue; **no admin org-wide view** | `src/lib/mentorAttention.ts:7,31-51,98-133` |
| Cross-customer / cross-program benchmarking | Together, MentorcliQ (RISE), 10KC | 🟡 cross-program only, **k-anonymity floor of 5** — none of theirs publishes a privacy model | `src/app/api/admin/analytics/benchmark/route.ts:16` |
| Custom report builder | Together, Qooper, Symplicity, Mentoring Complete | ❌ **deliberate: six fixed board-shaped reports instead** | — |
| Reporting sliced by HR attributes (department, level, location) | Together, Qooper, MentorcliQ, Guider, Symplicity | ❌ requires an HRIS join we are not building | — |
| Source-institution → placement attribution | **none** | ✅ per-institution mentees → in-pipeline → hired → conversion % | `src/app/api/admin/analytics/sources/route.ts:183-224` |
| Consent-gated first-party behavioural analytics | **none documented** | ✅ ACTIVITY_TRACKING consent, query strings stripped, suppressed during impersonation | `src/app/api/track/pageview/route.ts:26-73`, `src/components/ActivityTracker.tsx:13-84` |
| SOURCE-partner reporting panel | n/a — no competitor models a referring institution | ❌ data exists behind an admin-only route | `src/app/source/page.tsx:22-107` |

### 4.7 Identity, tenancy and trust

| Capability | Competitors with it | Our status | Evidence |
|---|---|---|---|
| SAML 2.0 SSO | Together, Chronus, MentorcliQ, Qooper, Mentorloop, Torch, Mentornity, 10KC, Riipen | ✅ live round trip, per-tenant SP identifiers, **in the free core** | `src/lib/ssoSaml.ts:22-92`, `src/app/api/auth/sso/[slug]/acs/route.ts:15-59` |
| OIDC SSO | Qooper, 10KC | 🟡 **half-built and broken** — config accepts `oidc`, login always builds SAML | `src/lib/sso.ts:20-36` vs `src/app/api/auth/sso/[slug]/login/route.ts:19` |
| SCIM 2.0 provisioning and deprovisioning | Together, Mentorloop, 10KC, Qooper | ❌ **deliberate — scheduled SFTP/CSV instead** | — |
| TOTP 2FA with replay protection | most defer MFA to the IdP | ✅ consumed step burned into the user row, separate failure bucket | `src/lib/totp.ts:50-67`, `src/lib/auth.ts:182-215` |
| Enforced tenant query isolation | none publish an isolation model | 🟡 **engine complete, flag OFF everywhere** | `src/lib/orgContext.ts:86-162`, `src/lib/orgScope.ts:21` |
| Granular admin roles / delegated program admin | Together (2 tiers), 10KC (5 levels), Graduway, Riipen | ❌ one `ADMIN` role; any tenant admin can rewrite another tenant's SAML config | `prisma/schema.prisma:11-17`, `src/app/api/admin/organizations/route.ts:19,95,147` |
| Governed impersonation with user-visible transparency | **none document impersonation at all** | ✅ single-use grant, 30-min cap, mandatory reason, notification to the impersonated user | `src/app/api/admin/impersonate/route.ts:16-64` |
| Time-limited PII access as a product rule | **none** | ✅ mentor/company CV access ends 6 months after COMPLETED | `src/lib/retention.ts`, `docs/pii-access-lifecycle.md` |
| SOC 2 Type II / ISO 27001 | Together, Chronus, MentorcliQ, Handshake, Symplicity | ❌ **non-goal in year 1 — publish the free 80 % instead** | — |
| WCAG AA with automated regression evidence | Together (VPAT), MentorcliQ, 10KC, Riipen claim conformance; **none evidences a gate** | ✅ axe gate, 9 pages × 5 roles × light+dark, **zero-violation baseline** — but no published statement | `e2e/a11y-scan.spec.ts:22-80`, `docs/a11y-audit.md` |
| Self-host / source access | **none — all 16 are closed SaaS** | ✅ AGPL-3.0-or-later, dual licensed | `LICENSE`, `docs/legal/licensing-strategy.md` |

### 4.8 Integrations, API and AI

| Capability | Competitors with it | Our status | Evidence |
|---|---|---|---|
| Public REST API | Together (Professional+), Riipen, Symplicity, Handshake (read-only, partner-gated) | 🟡 **one endpoint**, `take: 200`, no pagination, no tenant filter | `src/app/api/v1/candidates/route.ts` |
| Signed outbound webhooks | **Riipen only** — the other 15 have "no webhooks" in their weakness lists | ✅ 7 HMAC-SHA256 events from 9 call sites, SSRF re-checked at delivery | `src/lib/webhooks.ts:11-59`, `src/lib/ssrfGuard.ts:60-102` |
| Webhook delivery log, retry, dead-letter, pause toggle | Riipen | ❌ failures swallowed into a log line | `src/lib/webhooks.ts:55-57`, `prisma/schema.prisma:1382` |
| OpenAPI reference + in-app API explorer | **9 of 16 publish no developer documentation at all** | ✅ ~300 operations generated from the TS AST, CI-guarded, Swagger explorer with a destructive-request gate | `scripts/openapi-generate.cjs`, `src/components/ApiExplorer.tsx:70-103` |
| Zapier / Make no-code connector | **none of the 16** | ❌ planned as *the* answer to "do you integrate with X" | — |
| HRIS connectors (Workday, SuccessFactors, BambooHR, Personio) | Together, Qooper, Chronus, MentorcliQ, Guider, Mentorloop | ❌ **non-goal** | — |
| ATS integration | Handshake (via Merge) | ❌ **non-goal — publish the write API instead** | — |
| AI matching | Together, Qooper, Chronus (MatchIQ), Guider, Mentorloop, PushFar | ✅ privacy-preserving re-rank, mentors sent as anonymous labels A–E | `src/lib/aiMentorMatch.ts:103-108`, `src/app/api/admin/mentor-suggest/route.ts:71-108` |
| Enforced AI consent → quota → provider → metering chokepoint | Together comes closest (PII redaction + kill switch) | ✅ one mandatory gate, metered only after a successful call | `src/lib/aiGate.ts:32-56` |
| AI admin console (quota control, usage dashboard, provider status) | Together, Mentorloop (AI governance) | ❌ `aiMonthlyQuota` is not even settable from the admin UI | `src/app/admin/settings/page.tsx:128`, `src/lib/settings.ts:35` |
| AI session agendas | Together, Qooper, Chronus | ❌ | — |
| Rate limiting on AI endpoints | n/a | ❌ none of the AI routes are rate-limited | `src/lib/aiGate.ts` |

### 4.9 Experience and commercial model

| Capability | Competitors with it | Our status | Evidence |
|---|---|---|---|
| Multi-language product | Chronus (18), 10KC (5), Together (**Enterprise-only, per language, human translation extra**), MentorcliQ (**top tier only**), PushFar | ✅ EN/TR/DE, 3 490 keys × 3, CI-enforced parity, **free at every tier** | `src/i18n/dictionaries.ts:5,3526,3528,7016`, `npm run check:i18n` |
| Per-recipient localisation of email, notifications and push | 10KC never translates member content; Mentorloop advises *against* multilingual forms | ✅ | `src/services/emailService.ts:1159`, `src/lib/notify.ts:15` |
| Dark mode | **none of the 16 mentions it** | ✅ class-based, no-flash, hand-tuned override layer | `src/app/globals.css:41-184`, `src/app/layout.tsx:37-71` |
| Native mobile app | Qooper, MentorcliQ, Graduway, Mentoring Complete, Together (inconsistent) | 🟡 installable PWA + web push for **every** role | `src/app/manifest.ts:5-56`, `public/sw.js:3-17` |
| Published price on the vendor's own pricing page | **3 of 16** — MentorcliQ, Mentorloop, Mentornity | ❌ **the Wave-2 wedge** | — |
| Self-serve checkout | Mentorloop (Pro, in-app) | ❌ no billing surface of any kind | — |
| Free tier for participants | Mentornity (≤10 users), Mentorloop (build-only), PushFar (individuals) | ✅ **free core by construction** — entitlements are default-deny by row presence | `src/lib/entitlements.ts:16-49` |
| Evaluate the product without a sales call | Mentorloop and Mentornity only | ✅ public demo wiped and reseeded twice daily + a per-PR environment | `.github/workflows/demo-reset.yml`, `docs/DEMO.md` |
| Per-tenant white-label branding | Guider, Mentornity, Graduway, Riipen, Together | 🟡 stored and applied to shells, 25 email templates and certificate PDFs; **not to pre-login or the accent palette** | `src/components/BrandWordmark.tsx:11-26`, `docs/white-label.md:31-40` |

---

## 5. What we have that nobody else does

Twelve claims, deduplicated from 184 candidate advantages. Each is either absent from all 1 378 catalogued
competitor features, or present nowhere in a comparable form.

### 5.1 The mentee → internship → hired pipeline

**All sixteen platforms stop short of it.** The eleven mentoring vendors stop at the mentoring
relationship — their own analyses concede mentoring "stops at development". The three experiential-learning
marketplaces stop at the project deliverable. Handshake and Symplicity have hiring but no mentoring
relationship, and their internship modules approve a placement rather than run a pipeline.

We ship a 13-stage, per-tenant-configurable pipeline as a first-class domain object
(`prisma/schema.prisma:41-59`, `src/lib/pipeline.ts:6-20`, `src/lib/pipelineStages.ts:17-38`), with:

- **Per-stage SLAs stored separately from the stage definition** (`prisma/schema.prisma:176-190`) so
  relabelling or reordering a stage never destroys the clock. No competitor puts a time budget on a stage
  at all; Together and Chronus only nudge on session cadence.
- **A structured drop-off reason taxonomy** enforced on every write path
  (`src/lib/dropoffReasons.ts:6-22`, `src/lib/stageChange.ts:20-52`) with a stage × reason report.
  Competitors have at best a free-text close-loop survey; none can answer *"why do we lose people at
  stage 4"* quantitatively.
- **Real stage dwell time** — average *and* median, computed from consecutive `StatusChange` hops, with
  an oldest-stuck top 10 (`src/app/api/admin/analytics/aging/route.ts:83-152`). Vendors report survey-
  derived "match health"; nobody reconstructs actual time-in-stage from an immutable history.
- **Right-censoring-aware time-to-hire that reports the population it was computed over**
  (`src/lib/funnelKpi.ts:87-125`) — statistically honest in a market where every vendor quotes an
  unqualified average.
- **One chokepoint for every stage side effect** — notification, webhook, SLA deadline refresh,
  custom-label snapshot (`src/lib/stageChangeEffects.ts:20-90`) — so a new effect cannot be forgotten on
  one of the three write paths.
- **Stage storage as a free `String`, not an enum** (`prisma/schema.prisma:1695-1699`), so a tenant can
  define genuinely new stage keys rather than only renaming ours.

### 5.2 Berichtsheft / weekly-report oversight

A full DRAFT → SUBMITTED → APPROVED/CHANGES_REQUESTED workflow with mentor comments, a Friday reminder
cron, canonical UTC week de-duplication and a printable chronological diary
(`src/components/WeeklyReportsPanel.tsx:25`). **No mentoring competitor has an internship reporting
artefact at all.** Handshake and Symplicity approve placements and log hours but never capture the weekly
diary that DACH vocational and dual-study programmes are legally built around.

The gap on our side is narrow and named: there is no org-wide admin view or export
(`src/app/api/weekly-reports/route.ts:26`). That single screen is what Persona B buys.

### 5.3 Trilingual product, free at every tier

3 490 keys × EN/TR/DE in one typed dictionary with CI-enforced key parity and empty-value detection
(`src/i18n/dictionaries.ts:5,3526,3528,7016`), extending all the way down to per-recipient localised
transactional email, ~110 notification event templates, push payloads, announcements, goal templates and
certificate dates. A `LanguageBadge` even tells a mentor which language their mentee reads *before* they
start typing.

Compare: **Together sells localisation as Enterprise-only at a per-language fee with human translation
extra. MentorcliQ locks multi-language to its top tier. Mentorgain is English-only. 10KC ships five UI
languages but never translates member-generated content. Mentorloop explicitly advises customers against
multilingual forms.** We give away what they upsell.

### 5.4 AGPL self-host and genuine data ownership

`AGPL-3.0-or-later` with dual licensing and a single natural-person rights holder. **All sixteen
competitors are closed-source SaaS, and thirteen of them will not even show you a price.** "You can run it
yourself, read the code, and see the price" is a positioning none of them can copy — and it is also the
answer to data residency for any buyer we cannot host in-region.

It compounds with a second fact: Together, Chronus and 10KC all pool customer data for cross-customer
benchmarking. For a European public-sector or university buyer that is a procurement blocker we simply do
not have.

### 5.5 Mentor-gated candidate access

An interview request must be approved by an ADMIN **or by the mentee's own active mentor** before a
company gets access (`src/app/api/interview-requests/[id]/route.ts:32`), and a candidate is visible in the
talent pool only with `publicProfile` **and** an active `TALENT_POOL_VISIBILITY` consent
(`src/app/api/company/talent-pool/route.ts:31-39`). PASS decisions are never relayed to the candidate.

**No competitor models a human who knows the candidate standing between employer demand and candidate
exposure.** Handshake and Symplicity expose the student directly; Handshake and Parker Dewey ship
demographic and school-org filters by default.

### 5.6 The SOURCE role

A referring institution — a university career centre, a training provider, an IHK-adjacent body — is a
first-class role with its own portal (`src/app/source/page.tsx:22-107`), and referral attribution runs all
the way to a hire: per-institution mentees → in-pipeline → hired → conversion %
(`src/app/api/admin/analytics/sources/route.ts:183-224`).

**No competitor models the referring institution as an actor.** Handshake has employer analytics but no
source-institution conversion report; the mentoring vendors provision from an HRIS roster and therefore
have no acquisition funnel at all. The SOURCE outcome panel is currently admin-only — exposing it to the
institution itself is a Wave-2 item and the reason Persona B renews.

### 5.7 Free forever for mentors and mentees, by construction

Entitlements are **default-deny by row presence** (`src/lib/entitlements.ts:16-49`), so the free core is
preserved architecturally rather than by policy. Messaging, meetings, video, availability and self-booking,
goals, to-dos, evaluations, weekly reports, Q&A, documents, certificates, the mentee journey tracker, the
mobile PWA, all three languages, dark mode and every participant-facing AI feature are never behind a tier.

Every named competitor meters the participant: Together bills actively matched users, Mentornity bills
active participants, MentorcliQ bills employees ($99/employee/yr), Mentorloop bills participant bands,
Mentoring Complete bills matches. **Participation itself costs their buyer money.** Ours never does.

### 5.8 Communications engineering the category does not attempt

- **An inbound email reply bridge** — HMAC `Reply-To` tokens, an IMAP poller *and* a provider webhook,
  quoted-reply stripping in EN/TR/DE, `Message-ID` idempotency (`src/lib/inboundEmail.ts`,
  `src/lib/replyToken.ts`). Chronus is explicitly criticised because Outlook replies do **not** route back
  into the platform.
- **One-click actions from a notification email** — mark-as-read and five emoji reactions via 90-day
  signed tokens executed from a browser page so link scanners cannot fire them
  (`src/lib/emailActionToken.ts`, `src/app/m/[token]/page.tsx`).
- **A 13-group unsubscribe taxonomy enforced centrally inside `sendEmail()`**, RFC 8058 one-click
  unsubscribe with `List-Unsubscribe-Post`, two outbound transports on separate From domains so a
  newsletter blast can never damage password-reset deliverability, and a delivery ledger with hourly
  health alerting (`src/lib/emailGroups.ts:22`, `src/lib/unsubscribeToken.ts:5`,
  `prisma/schema.prisma:2453`, `src/lib/emailHealth.ts:30-47`).

### 5.9 Governed dormancy instead of indefinite nagging

A mentee stuck at first contact with no reply for 14 days drops out of the mentor attention queue (with a
visible "N hidden" footnote) and gets **at most two** "still interested?" emails — day 14 and +31 days —
with any sign of life resetting the stamp and the counters (`src/lib/dormantFirstContact.ts`,
`docs/dormant-first-contacts.md`). Two boundaries are written down as non-negotiable: **no third email**
and **no automatic stage change or closure.**

Only Mentorgain ships a dormancy mechanic at all, and it nudges without a documented ceiling. Everyone else
either nags indefinitely or auto-prunes silently (10KC's opt-in clean-up).

### 5.10 Privacy-by-construction AI

One mandatory chokepoint — consent → org quota → provider configured → call → metering, and metering
happens **only after a successful call** so a provider failure never consumes the customer's credit
(`src/lib/aiGate.ts:32-56`). Mentors reach the model as anonymous labels A–E with skills and load only and
the mentee is unnamed (`src/lib/aiMentorMatch.ts:103-108`); CV extraction sends extracted **text**, never
the file; interview prep sends only target position and skills. Per-feature GDPR consent belongs to the
data subject, self-serve grant and revoke. With no provider or no quota, matching degrades to the
deterministic ranking with `aiUsed:false` rather than erroring, and a local vocabulary-based CV parser
still works with zero provider and zero consent (`src/lib/cvParse.ts`).

Together markets "AI PII redaction" as an enterprise feature; ours is the default and is enforced at the
chokepoint. MentorcliQ locks participant AI to CliQ Plus, Qooper to the enterprise tier, Torch sells Spark
as its own SKU — **we never show a mentee an AI paywall.**

### 5.11 Testable quality where the category sells certificates

- **An axe-core WCAG 2.0/2.1/2.2 A+AA regression gate** over 9 pages × 5 role contexts × light *and* dark,
  diffed against a frozen baseline that is **currently empty at every severity**
  (`e2e/a11y-scan.spec.ts:22-80`, `docs/a11y-audit.md`). Mentorloop's own statement admits "partially
  compliant" with named open defects; Chronus, Guider, Qooper, Mentorgain and Mentornity publish nothing.
- **A 353-file Playwright suite** with a 91-test `@smoke` PR gate and a 4×/day 4-way-sharded full run,
  plus 17 dedicated security specs (rate limiting, IDOR, remember-me theft, impersonation governance, SSO
  mapping, tenant isolation). Competitors sell SOC 2 reports; nobody shows a regression suite.
- **A phone/tablet layout audit that runs in Turkish *and* German** at 360 px and 768 px, enforcing "no box
  may spill its own content" — an automated defence against the single most repeated complaint in the
  entire competitive set: *cluttered, dated, hard to navigate, feels like 2008.*
- **An automated monthly restore drill** into a guarded scratch database with row-count verification and a
  measured RPO/RTO log (`infra/restore-drill.sh`, `.github/workflows/backup-verify.yml:107-131`). Chronus
  mentions DR simulations twice a year; nobody else evidences a drill, and none publish a log.
- **A destructive-schema gate** on every deploy that refuses to proceed if the SQL would destroy data
  unless a backup was taken in the same run (`infra/schema-guard.sh`).

### 5.12 Contributors built the product — and the trail proves it

Release traceability runs down to the minute: one fragment per shipped change, the version derived at
build time, the git SHA baked into the image and readable from `/api/health` and the page footer, and a
public `/release-notes` page. **Handshake has a public changelog; nobody else ties a running deployment to
an individual reviewed change.** On top of that sits contributor-terms acceptance reporting — who accepted
which version, when, for what scope (`src/lib/contributorTermsReport.ts`) — an IP due-diligence artefact
no competitor exposes, and the artefact that makes the dual-licensing story credible to an acquirer or an
enterprise legal team.

Nine bespoke CI guard scripts encode real past incidents (auth-path reads, unvalidated Prisma where-filters,
demo-mode blocklist drift, i18n key parity, k6 parse validity, OpenAPI honesty, release-fragment
arithmetic). The gates are institutional memory, not boilerplate — and they are the reason a small
contributor team can move at this surface area without breaking the free core.

---

## 6. Gap analysis by domain

### 6.1 The 348 gaps at a glance

| # | Domain | P0 | P1 | P2 | P3 | Total | Dominant theme |
|---|---|---|---|---|---|---|---|
| 1 | Identity, session, SSO, security | 8 | 6 | 8 | 2 | 24 | OIDC is broken, no super-admin, no SCIM, no trust surface |
| 2 | Multi-tenancy, orgs, white-label, entitlements | 8 | 10 | 5 | 1 | 24 | The isolation engine is built and switched off |
| 3 | Pipeline, relations, stages, SLA | 3 | 10 | 8 | 3 | 24 | No lifecycle states; canonical keys still hardcoded downstream |
| 4 | Matching, mentor discovery, application flows | 6 | 11 | 7 | 2 | 26 | No bulk matching, no weighted rules, directory→request is broken |
| 5 | Messaging, notifications, email, push, newsletter | 3 | 13 | 8 | 1 | 25 | Slack/Teams absent; push only fires for messages |
| 6 | Meetings, calendar, availability, video | 4 | 13 | 7 | 1 | 25 | **No reschedule/cancel/delete**; Google sync half-wired |
| 7 | Goals, tasks, evaluations, development, content | 4 | 9 | 8 | 2 | 23 | No survey engine, no session agendas, Goal/ProjectTask split |
| 8 | Company, requisition, offer, interview, hiring | 5 | 14 | 6 | 1 | 26 | Interview loop dead-ends; no company self-signup; no billing |
| 9 | Analytics, reporting, ROI, dashboard | 3 | 10 | 11 | 1 | 25 | **Zero ROI/financial fields exist**; premium gating is one global flag |
| 10 | Integrations, public API, webhooks | 7 | 12 | 6 | 1 | 26 | One public endpoint; no delivery log; no Zapier |
| 11 | AI features | 4 | 13 | 8 | 0 | 25 | No admin console, no per-tenant quota, no rate limiting |
| 12 | UI/UX, i18n, a11y, mobile, PWA, dark mode | 3 | 9 | 10 | 1 | 23 | No published conformance statement; SW cache leak; no locale routes |
| 13 | Admin experience, program administration, settings | 5 | 9 | 8 | 3 | 25 | `Setting` is global; one `ADMIN` role; no Program object |
| 14 | Infrastructure, testing, deploy, observability, data | 6 | 12 | 8 | 1 | 27 | No APM/error tracking; single-host SPOF; `AuditLog` write-only |
| | **Total** | **69** | **151** | **108** | **20** | **348** | ≈1 659 story points |

Effort distribution: 53 × S, 161 × M, 104 × L, 30 × XL. Status: **209 partial, 139 missing** — which is
itself the headline. Most of what is "missing" is the last mile of something already built.

### 6.2 The P0 list in full

**Identity, session, SSO, security (8)**

| Gap | Status | Effort |
|---|---|---|
| SCIM 2.0 user provisioning and deprovisioning | missing | XL / 8 st |
| OIDC single sign-on (currently a broken half-path) | partial | L / 5 st |
| Per-tenant SSO enforcement (disable password login) | missing | M / 3 st |
| Admin session revocation, and deactivation actually signing a user out | partial | M / 4 st |
| 2FA recovery codes and admin-side 2FA reset | missing | M / 4 st |
| API key scoping, expiry, ownership and tenant binding | partial | L / 5 st |
| Super-admin vs tenant-admin separation for SSO/org config | missing | L / 5 st |
| Security and compliance trust surface (SOC 2 path, subprocessors, DPA, status page) | missing | L / 6 st |

**Multi-tenancy, orgs, white-label, entitlements (8)**

| Gap | Status | Effort |
|---|---|---|
| Turn on tenant isolation enforcement (`MT_ENFORCE_ISOLATION` rollout) | partial | L / 6 st |
| Complete the auto-scoped model set — 7 orgId models bypass the middleware | partial | M / 4 st |
| Super-admin vs tenant-admin role separation | missing | L / 5 st |
| Per-tenant settings (`Setting` has no `orgId`) | missing | L / 5 st |
| Tenant-scope API keys, webhooks and AI usage (live cross-tenant read) | missing | M / 5 st |
| Host → organization resolution and custom domains | partial | L / 6 st |
| Commercial layer: plans, Stripe subscriptions, self-serve upgrade | missing | XL / 10 st |
| Unify entitlement gating and enforce the five decorative feature keys | partial | L / 6 st |

**Pipeline (3)** — relationship lifecycle states beyond ACTIVE/COMPLETED (missing, L/8); Program as a
first-class container so stages, SLAs and cadence stop being per-org only (partial, XL/9); canonical stage
keys still hardcoded across analytics, reminders and journey, so a customised pipeline silently reports
zero (partial, M/6).

**Matching (6)** — mentee-facing requisition board with an apply flow (missing, L/6); **"Request this
mentor" CTA on the directory (partial, S/2 — two points, and its absence makes a shipped feature read as
broken)**; bulk/cohort-wide matching (missing, XL/7); admin-configurable weighted criteria with hard rules
(partial, XL/8); re-match / change-mentor flow (missing, M/4); wire matching intelligence into the screen
where mentors are actually chosen (partial, M/3).

**Communications (3)** — Slack app (missing, L/7); Microsoft Teams app (missing, L/7); GDPR erasure must
scrub message bodies, attachments and support messages (partial, M/3).

**Meetings (4)** — reschedule, cancel and delete a meeting (missing, M/6); Microsoft 365 / Outlook calendar
(missing, L/7); complete the Google Calendar sync loop across all write paths (partial, M/5); group and
multi-party video that does not get cut off (partial, M/5).

**Development (4)** — session agendas and a guided conversation library (missing, L/8); program survey
engine incl. pulse and NPS (missing, XL/9); program structure engine with milestones, drip content and
stage-triggered automation (partial, L/8); **org-wide Berichtsheft oversight, compliance dashboard and
export (partial, M/6)**.

**Hiring (5)** — commercial layer with Stripe and invoices (missing, XL/9); company self-service sign-up
(partial, L/6); close the interview loop from approved request → scheduled interview → outcome
(partial, M/6); accepted offer fills the requisition and moves the pipeline (partial, M/4); enforce the
five decorative premium entitlements (partial, M/5).

**Analytics (3)** — ROI and business-outcome reporting (missing, XL/8); premium analytics gated
per-tenant instead of one global boolean (partial, M/5); premium reports silently returning zero on a
customised pipeline (partial, M/4).

**Integrations (7)** — Teams app (missing, XL/8); Slack app (missing, L/7); SCIM (partial, L/6); HRIS
connectors (missing, XL/10); Outlook calendar (partial, L/7); complete the Google Calendar loop
(partial, M/5); scoped, expiring, org-bound API keys (partial, M/5).

**AI (4)** — AI admin console for quota, usage and provider status (partial, M/5); per-tenant and
per-company AI quota with real `AI_PACKAGE` enforcement (partial, L/6); rate limiting and abuse controls
on every AI endpoint (missing, S/3); prompt-injection hardening and output safety (missing, M/4).

**UI/UX (3)** — published accessibility conformance statement + VPAT + EAA/EN 301 549 page (partial, M/4);
service worker leaking authenticated API responses across accounts (partial, S/4); close the accessibility
blind spots the gate cannot see (partial, M/6).

**Admin (5)** — per-tenant settings (partial, L/6); granular admin roles (missing, L/7); first-class
Program object (partial, XL/9); commercial layer (missing, XL/10); plan/quota enforcement with a usage
dashboard and in-product upgrade path (partial, L/5).

**Infrastructure (6)** — off-site geo-redundant encrypted backups (partial, L/5); error tracking and APM
(missing, M/6); external uptime monitoring, status page and published SLA (missing, M/5); Trust Center
(missing, XL/9); remove the single-host SPOF and make the app multi-replica safe (partial, XL/8); durable
background job queue replacing in-process `node-cron` (partial, L/6).

### 6.3 What the critics found that the 348 gaps missed

Three review passes added categories the domain-by-domain sweep could not see:

- **Third parties who are neither mentor, mentee, admin nor company.** No line-manager/supervisor role
  (Together ships a manager view, Qooper mails managers a digest with no login, Torch runs a manager
  alignment meeting) — and in a DACH internship the supervisor is who signs off. No act-without-an-account
  guest links. No observer/read-only stakeholder. **No parental consent or age gate for under-16s**, which
  GDPR Art. 8 requires for any school programme.
- **Legal compliance of the hiring act itself.** We already rank candidates for hiring with an LLM and have
  **no EU AI Act risk classification, no human-review guarantee, no appeal path and no logging of the
  automated decision** — recruitment AI is high-risk under the AI Act and NYC LL144 requires a published
  bias audit. No work-authorisation or visa fields. No `Praktikumsvertrag` or country-specific internship
  law artefact — which is precisely our differentiated lane.
- **Trust and safety.** No block, no report-a-user, no moderation queue. No employer verification or
  anti-fraud scoring — and company self-signup is already a P0. **No antivirus scanning or MIME
  allowlisting on uploads**, while we accept arbitrary bytes into the DB and serve them back to other users.
- **Money flowing *to* participants.** Paid internships are the norm in DE/TR and we cannot move a euro to
  a mentee. No stipend payouts, no VAT/KDV handling, no timesheet with supervisor approval.
- **Engineering non-functionals nobody assigned.** `MessageAttachment.data` lives as **DB bytes** — this
  caps message history, backup size and restore time simultaneously. No feature-flag service with
  per-tenant targeting (which is exactly why `MT_ENFORCE_ISOLATION` is a single global env var). No
  front-end performance monitoring — the mobile mentee on Turkish 4G is invisible to every gate we have.

---

## 7. Sequencing

The CTO critic verified the following in the repo before sequencing: `ApiKey` has no `orgId`
(`schema.prisma:1387`); `Setting` is a bare `key String @id` + value (`:1397`); `TENANT_MODELS` lists
exactly 11 models (`src/lib/orgContext.ts:43`); `MT_ENFORCE_ISOLATION` is read in one place
(`orgScope.ts:22`) and defaults off; `Cohort` already carries an optional `orgId` (`:1659`) — it is the
seed of a Program object; `entitlements.ts` keys features on **companyId** while `planGate.ts` keys limits
on **orgId**; there are 215 route files; and `node-cron` runs in-process from a 3 208-line
`emailService.ts`.

Everything below is foundational. Everything not below is a leaf that hangs off one of these.

### F0 — Reviewable schema migrations

Replace `db push --accept-data-loss` in the deploy path. **This is not on the gap list and it is the hard
prerequisite for F1–F5.** Every foundational item below is a re-key, a merge or a primary-key change, and
today those run unreviewed against the shared MySQL at deploy time; the server-side destructive-SQL guard
fires *after* the PR is merged, which is the wrong end of the process. Worse, each per-PR topic environment
pushes against its own fresh database, so a destructive diff looks perfectly healthy on the PR and only
bites production.

→ **F1, F3, F4, F6**, and the taxonomy / CompanyNeed / Goal-unification work.

### F1 — Finish the tenant key, then enforce

Add `orgId` to `Setting`, `ApiKey`, `Webhook`, `AiUsage`, `ActivityLog`, `PageView`; add the eight
`orgId`-carrying models that currently bypass the middleware (`Tag`, `StageSla`, `PipelineStage`,
`EvaluationTemplate`, `Offer`, `CompanyInquiry`, `InterviewPanel`, `InvitationToken`) to `TENANT_MODELS`;
build a CI gate that seeds two tenants with the flag **on** and proves no surface leaks; *then* flip it.

→ per-tenant settings, per-tenant AI quota, per-tenant analytics gating, SSO enforcement, scoped API keys,
seat metering, tenant export, custom domains, HRIS/DEI segmentation. **Roughly a third of the P0/P1 list is
downstream of this one item.**

**Corollary: do not flip the flag before the uncovered models are in.** A partially-true isolation guarantee
is worse than an honest "single-tenant today".

### F2 — A permission model, not a role enum

One `can(actor, action, subject)` with SUPER_ADMIN / org admin / program admin / read-only. The immediate
driver is a live cross-tenant escalation: `/api/admin/organizations` authorises on `role === 'ADMIN'`, so
**any tenant admin can rewrite another tenant's SAML issuer and certificate** — that is, redirect another
tenant's authentication.

→ delegated and program admins, impersonation governance, an audit viewer, self-serve integration
credentials, company team seats, a tenant-facing billing page, and SCIM (which needs a role to map to).

### F3 — Host → organization resolution

Small, and the only thing standing between stored branding and any pre-login surface.

→ custom domains, pre-login white-label, tenant welcome page, per-tenant SSO discovery,
`brandColor` → accent wiring. **Four gap entries collapse into one afternoon of plumbing plus a
`customDomain` column.**

### F4 — Program as a first-class object

Promote `Cohort`. Re-key `PipelineStage`, `StageSla`, matching config, enrolment rules and comms templates
from `orgId` → `programId`, with the org row as the default. `Cohort` already has the `orgId` FK, so this
is a promotion rather than a new tree.

→ per-program stages and SLAs, program templates and clone-for-next-intake, program-count-as-a-pricing-lever
(Chronus's own paywall), per-program enrolment windows, multi-program reporting.

### F5 — Settings resolution chain

`global → org → program`, behind one accessor. Depends on F1 + F4. Unlocks per-tenant 2FA policy, retention
windows, reminder cadence, AI quota, terminology overrides and per-program nudge lead times — all of which
are one global row each today.

### F6 — Durable job queue plus a transactional outbox

Replaces in-process `node-cron`. **The outbox is also the event bus — do them as one project, not two.**

→ multi-replica operation (with the in-memory rate limiter and the in-process realtime bus, in-process cron
is the third of three SPOFs blocking a second container), webhook retries and a delivery log, email
queue/retry/DLQ, bounce handling, scheduled report delivery, SFTP/HRIS sync, custom nudge rules, newsletter
at volume.

### F7 — Domain event bus

Generalise `emitStageChange` into one event stream feeding webhooks, notifications, `AuditLog`,
`ActivityLog`, analytics, and later admin-authored automation rules.

→ webhook catalogue expansion, stage automation rules, a custom nudge builder, the Zapier app, SIEM
streaming, the audit viewer, lifecycle events on the public API. **Without it, every one of those is a
separate hand-wired call site across 215 routes.**

### F8 — Notification and delivery abstraction

`notify(user, event, payload)` with channel routing and per-user, per-category channel preference. Depends
on F6/F7. Today delivery decisions are baked into a 3 208-line `emailService.ts`.

→ a Slack app, a Teams app, SMS/WhatsApp, push for every event type, channel preferences, admin-editable
templates. **Build the router and the chat platforms become adapters instead of three parallel fan-out
implementations.**

### F9 — Unified entitlement and metering spine — and pick ONE billing subject

This is the fork nobody in the gap doc named: entitlements are keyed on **Company**, plan limits on
**Organization**, and `premiumAnalytics` is a **global Setting**. Three subjects. Choose Organization as
the billing subject with Company as a role inside it, collapse the other two into it, add a usage-event
table plus an aggregation job and enforcement middleware. **Only then wire Stripe.**

→ self-serve checkout, a plan self-service page, per-tenant AI quota, an integration tier, seat enforcement
at provisioning, analytics tiering, and the five currently decorative feature keys.

### F10 — Test and observability floor

A unit-test runner for `src/`, error tracking, external uptime monitoring. Every item F0–F9 is a large
refactor, and right now the only way to test pure logic is to boot a browser through Playwright. **This is
the thing that decides whether the foundational work above is survivable.**

### Cross-cutting prerequisite — a canonical skill taxonomy

Free text split on commas in four places is the shared bottleneck under matching, talent-pool search,
requisition alerts, skills-gap reporting and semantic AI. It is a data-model change (so it sits behind F0)
and it unblocks roughly eight gap entries across four domains.

### The ten changes that move the trajectory, ranked

1. **Reviewable migrations replacing `db push` in the deploy path (F0).** Unglamorous, gates everything
   else, and is itself the change-management artefact enterprise questionnaires ask for.
2. **Fix the three live security defects** — each hours, not sprints: any ADMIN can overwrite another org's
   SAML config; `/api/v1/candidates` reads every MENTEE with no tenant filter on an unscoped permanent key;
   deactivation never stamps `sessionsValidFrom`. Also reject `'oidc'` at the write boundary until it is
   implemented. **None of these needs the foundational work first, and all of them are disqualifying in a
   buyer's security review.**
3. **Complete the tenant key and flip isolation behind a two-tenant CI leak gate (F1).** Converts "we built
   an isolation engine" into a sellable claim.
4. **Unified entitlement and metering spine, then Stripe self-serve checkout (F9).** Self-serve pricing
   against 13 vendors who publish none is a positioning weapon, not plumbing.
5. **Program as a first-class object (F4).**
6. **Durable job queue + outbox/event bus (F6+F7 as one project).**
7. **Per-tenant / per-program settings resolution (F5).**
8. **Relationship lifecycle states — pause, re-match, extend, cancel, bench — plus a close-loop survey.**
   Cheapest possible fix to the credibility of every conversion and time-to-hire number we sell, since a
   bad match today can only be recorded as COMPLETED.
9. **Notification abstraction plus one chat adapter (F8).** Do not let Slack/Teams be built without it.
10. **Canonical skill taxonomy.**

**Near-free items that should ride along rather than queue behind the ten:** publish the accessibility
statement and VPAT (the axe baseline is already zero violations — we have better evidence than the
competitors making the claim); ship the "Request this mentor" CTA (2 points, and its absence makes a
shipped feature read as broken); give `removeMeeting()` its missing call sites and add meeting
reschedule/cancel (a ghost meeting on a real calendar destroys trust in the whole integration); seed demo
rows for `Requisition`, `Offer`, `InterviewRequest`, `WeeklyReport` and `DocumentRequirement`, **because
the differentiating pipeline currently renders as empty screens on every demo and every PR environment**;
and stand up the unit-test runner, error tracker and uptime monitor as the safety net for items 1–10.

---

## 8. Risks and explicit non-goals

### 8.1 Risks

| Risk | Why it is real here | What to do |
|---|---|---|
| **Schema surgery under `db push --accept-data-loss`** | `db push` has been fine because our changes were additive. The foundational work is not. Adding `orgId` to `Setting` changes the primary key of a `String @id` table; retiring `CompanyNeed`, unifying `Goal` and `ProjectTask`, re-keying `PipelineStage`/`StageSla` to `programId`, splitting `Role`, and converting free-text skills to a taxonomy all resolve as drop-and-recreate. Each per-PR topic env pushes against a fresh DB, so a destructive diff looks healthy on the PR and only bites production. | **Do not start any of it before F0.** This is the single biggest technical risk in the plan. |
| **SCIM 2.0 treated as a feature** | Listed P0 in two domains. It is a full protocol server — Users, Groups, PATCH semantics, filter grammar, Okta and Entra certification — and it presupposes F1, F2 and F4. Before a second real tenant exists it returns literally zero. | Ship **scheduled SFTP/CSV delta ingestion with automatic deprovisioning** — a fifth of the cost, closes the same mid-market deals, and is what 10KC actually runs for ADP and Oracle. Keep SCIM for the first buyer who names it in a contract. |
| **SOC 2 Type II as an engineering item** | It is money and 6–12 months of evidence collection, not a sprint. And it cannot honestly pass while prod, preview, demo, every PR environment and MySQL share one Plesk box and deploys run `--accept-data-loss`. | Fix the infrastructure; publish the free 80 % now (trust page, subprocessor register, DPA template, pen-test summary, status page); start the audit after. |
| **Data residency / multi-region** | XL, and on single-host architecture it means standing up and operating a second full deployment. | Answer it contractually plus the AGPL self-host option until a signed deal pays for the region. |
| **Slack app AND Teams app as two parallel P0 XL builds** | Without F8 that is the same fan-out logic written three times into an already 3 208-line file. | Build F8, ship one adapter, and pick Teams if the buyer is enterprise HR. |
| **Whole products masquerading as gaps** | ATS-via-Merge, HRIS connectors, LMS/LTI, career-fair and OCI scheduling (Symplicity's engine is a decade of work), AI notetaker with recording and consent design, 360 multi-rater, RTL, embeddable widgets. | Each is a company's roadmap, not a line item. **None until a named customer is paying for it.** |
| **Predictive analytics and cross-installation benchmarking** | We do not have the volume for a model to beat a rules table, and the benchmark needs installations we do not have. | Ship a **deterministic** health score and call it deterministic — more defensible than a scored black box. |
| **The meta-risk** | ~348 gaps at ~1 659 story points, and this is a small team. Competing on the enterprise mentoring checklist (SCIM + HRIS + LMS + Teams + SOC 2 + multi-region) is a 20-engineer roadmap we would lose. | **The defensible position is the one thing none of the 16 vendors model — internship→hire pipeline — sold self-serve against a field of 13 quote-only competitors.** |

### 8.2 Explicit non-goals, with the reason and the sentence we say instead

| We will not build | Reason | What we say |
|---|---|---|
| SOC 2 Type II audit in year 1 | €40–80k and 12 months; cannot honestly pass on the current single-host infrastructure | "Trust Center, subprocessors, DPA, annual pen test, and AGPL source you can audit yourself. SOC 2 when a signed contract pays for it." |
| SCIM 2.0, sub-organisations, multi-region residency, HRIS connectors | They exist to win the 5 000-employee L&D deal we are not bidding on | "Scheduled SFTP/CSV ingestion with automatic deprovisioning — a fraction of the cost, same roster problem solved." |
| Microsoft Teams app and Slack app | The most-repeated integration in the category *and* the loudest omission — but ~15 story points each for a segment we are not selling to; our buyer's programme runs on email and a browser | "Zapier and signed webhooks. Revisit when three paying customers ask in writing." |
| Group / circle / peer / reverse / flash mentoring | The price of not chasing the L&D buyer. `MentorshipRelation` stays 1:1 | Say so plainly rather than half-building it. |
| ATS integrations (Greenhouse / Lever / Workday Recruiting) | Whole-product scope for a second wallet that has not opened yet | "Public write API and Zapier triggers — wire it yourself or through a partner." |
| Learning content: handbooks, mini-courses, quizzes, certification, LMS/LTI | We are a pipeline product, not a courseware vendor | "Link out to the LMS you already have." |
| Career fairs, OCI/booth/bidding engines, employer events | Symplicity's moat; six figures of engineering; wrong buyer | — |
| Custom report builder | Reviewers complain every competitor's builder is inflexible anyway | "Six fixed, board-shaped reports plus scheduled email plus CSV/XLSX export. Fixed and correct beats configurable and wrong." |
| 360 multi-rater, NPS-heavy survey suites, DEI/representation analytics, predictive risk scoring, cross-installation benchmarking | All downstream of a survey engine and an HRIS join we are not building this year | — |
| SMS / WhatsApp, native iOS/Android apps, RTL/Arabic, command palette, real offline mode, gamification | Cost far exceeds the segment each wins | "Installable PWA with push for every role, and a wrapped store listing if you need one." |
| A services and CSM business | Our cost structure — and therefore the price — only works because there is no sales call and no onboarding consultant | "One €890 migration SKU. No implementation fees beyond it. The moment we sell services we become the thing we are undercutting." |
| **Any paid tier for individual mentors or mentees. Ever.** | Not a limit, not a "pro" tier, not an AI credit pack | "The free core is the marketing." |

---

## 9. Go-to-market

### 9.1 The uncomfortable precondition

Five gap items are not sellable features — they are the **licence to sell**, because the pricing page is
what creates tenant #2. Budget ~25 story points and ship them *before* the pricing page goes live.

| # | Item |
|---|---|
| G0.1 | `MT_ENFORCE_ISOLATION` on in production **plus** the 7 un-scoped `orgId` models |
| G0.2 | Super-admin vs tenant-admin separation (any tenant admin can currently overwrite another tenant's SAML certificate) |
| G0.3 | `Setting` gets an `orgId` (2FA policy, retention and AI quota are global today) |
| G0.4 | `ApiKey` / `Webhook` / `AiUsage` org binding **plus** a tenant filter on `/api/v1/candidates` (live cross-tenant read) |
| G0.5 | Deactivation stamps `sessionsValidFrom`, plus an admin force-sign-out |

### 9.2 The three personas

We deliberately do **not** build for the enterprise L&D mentoring buyer (Chronus / MentorcliQ / Together's
customer). That buyer needs SCIM, Teams, SOC 2 Type II, sub-orgs, group mentoring and HRIS — 60+ story
points of table stakes we would lose on anyway. The three below are chosen because the internship→hire
pipeline, the Berichtsheft workflow, the trilingual product and AGPL self-host are already decisive for
them.

#### Persona A — "The Program Owner" *(primary; funds the roadmap)*

HR/talent lead or internship coordinator at a 100–1 000 employee employer in DE/AT/CH/TR. Runs 20–150
interns or graduate-programme mentees a year off a spreadsheet plus Outlook. €3–15k discretionary budget,
no procurement gauntlet under €10k, buys in Q3/Q4 for the next intake. **Trigger:** an intake is six weeks
out and last year's spreadsheet lost two candidates.

Must see before paying:

1. **A price on a page, and a card field.** If they have to book a call, they compare us to Together and
   lose interest.
2. Their pipeline on one board — stage, days-in-stage, SLA breach flag, drag to advance. This is the
   *"I can throw the spreadsheet away"* moment.
3. A program health screen that answers "which of my 80 pairs is dying" without asking anyone.
4. Time-to-launch under a day: template pipeline, bulk invite mentors and mentees, done.
5. Proof it will not embarrass them: mail in the participant's own language, works on a phone, a GDPR/DPA
   artefact they can forward to the Betriebsrat.

**Kills the deal:** no meeting reschedule/cancel; broken calendar sync; a demo tenant with empty hiring
screens; anything that requires a sales call. **Buys:** Program → Program Plus. **Expected ACV
€1 800–4 800.**

#### Persona B — "The Placing Institution" *(differentiator; low competition)*

Career services, dual-study coordinator, vocational or publicly funded training provider — Berufsakademie,
IHK-adjacent, Turkish university career centre. Sends candidates *outward* into employers and is legally or
contractually obliged to report on placement outcomes and to collect internship diaries. **Trigger:** an
accreditation or funder report currently assembled by hand.

Must see:

1. **Org-wide Berichtsheft / weekly-report oversight** — every intern's submission status this term, one
   screen, exportable. No mentoring vendor has this; Handshake and Symplicity have the approval chain but
   at six-figure prices.
2. A **SOURCE outcome panel**: of the 60 we referred, how many are placed, where, at what stage, over what
   time-to-placement.
3. Cohort/term as a real object — 2024/25 intake vs 2025/26, side by side.
4. Accessibility statement + WCAG/VPAT page (public-sector procurement asks *before* the demo) and an
   EU-hosting answer in writing.
5. Education pricing **published, not negotiated**.

**Kills the deal:** no export; English-only admin screens; no answer on where data sits. **Buys:** Program
at the 50 % education discount → Program Plus. **ACV €900–2 400** — but they are the supply engine and the
reference logo.

#### Persona C — "The Hiring Employer" *(second wallet; never subsidised by A or B)*

Recruiter or hiring manager at an SME/Mittelstand company receiving candidates from A or B. Does not want
another mentoring tool; wants the intern. **Trigger:** an open junior/intern requisition and no pipeline.

Must see:

1. Their own requisitions with a real applicant funnel **inside each role** — not a flag on a candidate.
2. The interview loop closing in-product: approved request → scheduled slot → outcome. Today it dead-ends
   into email; that is the single most visible broken promise on the hiring side.
3. An accepted offer filling the requisition and moving the pipeline automatically.
4. A candidate they can actually reach — mentor-gated and quota'd. **The mentor gate is a genuine
   differentiator, but zero channel kills the deal.**
5. A one-line answer to "what does this cost me": €99/mo or €890 per hire.

**Kills the deal:** re-keying into their ATS with no export or webhook; no seats for the hiring manager and
the interviewer. **Buys:** Employer / Employer Plus / placement fee. **ACV €1 200–3 600.**

### 9.3 Packaging and price

**Metering unit: the ACTIVE MATCHED PAIR per month.** Not seats. Publish the definition on the pricing
page: *"a relation in ACTIVE state with any logged activity in the calendar month; paused, benched and
completed pairs are not counted."* Mentors and mentees are never a billable unit — that is what makes the
free-core promise structurally credible rather than a slogan. We also **never charge per program** (Chronus's
paywall lever) and we say so out loud.

| Plan | Price (EUR, published) | Included | Who |
|---|---|---|---|
| **Free core** | **€0 forever, no card** | Every mentor and every mentee: messaging, meetings, video, goals, journey, portal, certificates, mobile/PWA, EN/TR/DE, all lifecycle email, all participant-facing AI. No cap, no expiry, no seat count. | Participants |
| **Community** | **€0** | 25 active pairs, 1 organisation, 2 admin seats, pipeline board, basic analytics, community support. Self-serve, no card. **The trial that never ends.** | Evaluators |
| **Program** | **€149/mo billed annually (€1 788/yr)** or €189/mo monthly | Up to 100 active pairs, unlimited programs and cohorts, 5 admin seats, stage SLAs + escalation, weekly-report oversight and export, full analytics + XLSX/CSV, scheduled report email, saved shared views, bulk invite/import, migration dry-run. Email support, 2 business days. | Persona A, Persona B |
| **Program Plus** | **€399/mo annually (€4 788/yr)** or €479 monthly | Up to 400 active pairs, 15 admin seats + delegated program-admin role, white-label incl. custom domain and brand colour, SSO (SAML and a working OIDC), public API + webhooks + Zapier app, per-tenant terminology, custom pipeline stages, audit-log viewer and export, priority support 1 business day. | Persona A at scale |
| **Enterprise** | **€749/mo, annual only — €8 988/yr, PUBLISHED** | Unlimited active pairs, EU-only hosting option, DPA + subprocessor register + pen-test summary, audit export/SIEM feed, 99.9 % uptime SLA, named onboarding, migration included, permanent sandbox tenant, quarterly review. | Large programs |

**Overage on Program is published too:** €1.20 per active pair per month above the band, or auto-upgrade —
the customer's choice.

> **The whole campaign is the Enterprise number.** Our top tier is printed on the website and sits under the
> price the incumbents refuse to print. Do not raise it above €9 000 — the sub-$10k line *is* the message.

**Employer side (separate wallet, sold to Persona C):**

| Plan | Price | Included |
|---|---|---|
| Employer Free | €0 | Brand page, 1 open requisition, respond to mentor-gated shortlists |
| Employer | €99/mo annually (€1 188/yr) | Unlimited requisitions, 5 seats, per-requisition applicant pipeline, interview scheduling, 50 candidate messages/mo, funnel analytics |
| Employer Plus | €299/mo annually | 20 seats, 500 messages, webhooks/API, employer analytics + benchmarking, offer-letter generation |
| Placement fee alternative | **€890 per confirmed hire**, no subscription | For low-volume employers. **Legal check required before launch** — placement/brokerage rules in DE and TR. Flag, do not assume. |

**Add-ons:** program/company-side AI pack €49/mo per org (admin AI, survey and free-text summarisation,
requisition fit scoring) — *participant-facing AI stays free*; migration service €890 one-off (spreadsheet
or competitor export including in-flight pairs and history); EU-only hosting €99/mo on Program Plus,
included in Enterprise; **additional languages €0** — Together charges per language at Enterprise only, we
give it away and say so.

**Discounts, published not negotiated:** 2 months free on annual, 50 % education/non-profit, and the AGPL
self-host build free forever. **Self-hosting is not revenue leakage — it is the proof that the price is
honest**, and it answers the data-residency question for anyone we cannot host.

### 9.4 The proof features that win the demo

Ordered by demo impact per story point. `[have]` = exists, needs polish; `[build]` = new.

1. **Public pricing page + calculator + Stripe self-serve checkout + in-product upgrade CTA wired to the
   existing 403s.** `[build]` In this category, the product *is* the pricing page.
2. **A live demo tenant seeded rich, including the hiring chain.** `[build, cheap]` `Requisition`, `Offer`,
   `InterviewRequest`, `InterviewPanel` and `WeeklyReport` are all empty in the seeder today. Our own agents
   have mistaken empty tables for broken features; a buyer will too.
3. **The internship→hire pipeline board** with days-in-stage, SLA clock and drag-to-advance, visible to
   mentors and not just admins. `[have]` These are the five minutes that end the comparison.
4. **Program health scorecard + at-risk pair queue** with a ranked score and a prescriptive next action.
   `[have as a mentor-side queue; needs the admin org-wide view]` This is the one screen Mentorloop and
   Mentornity win demos with.
5. **Weekly internship report (Berichtsheft) with an org-wide compliance dashboard and export.**
   `[have; needs the admin view]` Uncontested in DACH; the entire reason Persona B signs.
6. **Meeting reschedule/cancel/delete + a completed calendar sync loop** (Google now, Outlook next).
   `[build]` *"Trouble changing a meeting time"* is literally the top recurring complaint against Together —
   being visibly better at the thing everyone complains about is the cheapest credibility available.
7. **Relationship lifecycle: pause, re-match, extend, close-with-reason.** `[build]` Without it every
   outcome number we quote is a lie, and "my mentor left the company" has no product answer.
8. **Bulk cohort matching** — propose a whole intake, review as drafts, lock, publish, with a visible
   per-rule score and reason. `[build]` Disqualifying to be missing; explainability is what makes it
   demoable.
9. **Trilingual per-recipient product and email, free at every tier, with `/tr` and `/de` addressable
   URLs.** `[have; needs locale routes]`
10. **Trust page** — subprocessor register, DPA, pen-test summary, retention policy, EU hosting, status
    page, plus the WCAG/VPAT statement backed by our zero-violation axe baseline. `[build, mostly writing]`
    Mentorloop proves the cheap version works. **Silence is what stalls procurement, not the absence of
    SOC 2.**
11. **Webhooks + OpenAPI + a published Zapier app.** `[have webhooks and OpenAPI; build Zapier + delivery
    log]` Nine of sixteen competitors have "no Zapier connector" written into their weakness list.
12. **One-click migration import with a dry run** — spreadsheet or an incumbent's export, including live
    pairs and stage history. `[have partially]` Turns switching cost from their problem into our closing
    argument.

---

## Backlog

The work is tracked under **Initiative
[#1514 — Rakip analizi 2026-08 → ürünü satılabilir bir platforma taşı / Competitive gap
programme](https://github.com/21072026/Internship/issues/1514)**, itself a child of the `[_ROOT_]`
tracker (#736). The 348 gaps consolidate into **26 epics across six waves**. Every child issue carries an
English body (`Goal` / `Current state` with `file:line` evidence / `What to build` / `Acceptance
criteria`), a 🇹🇷 Türkçe özet, a ready-to-paste 🤖 agent prompt, and a P0–P3 priority. Stories live under
epics; tasks under stories.

### Wave 0 · Licence to sell — *you cannot invoice tenant #2 until these close*

| # | Epic | Maps to |
|---|---|---|
| 1 | Reviewable schema migrations — retire `db push --accept-data-loss` from the deploy path | F0 |
| 2 | Live security defect closure — cross-tenant SAML config, unscoped `/api/v1/candidates`, deactivation → `sessionsValidFrom`, reject `oidc` at the write boundary | Leverage #2 |
| 3 | Tenant isolation completion and enforcement — 8 un-scoped models, two-tenant CI leak gate, flip the flag | F1, G0.1/G0.4 |
| 4 | Admin permission model — SUPER_ADMIN / org admin / program admin / read-only | F2, G0.2 |

### Wave 1 · Platform spine — *every later epic hangs off these*

| # | Epic | Maps to |
|---|---|---|
| 5 | Program as a first-class object (promote `Cohort`; re-key stages, SLAs, cadence to `programId`) | F4 |
| 6 | Settings resolution chain: global → org → program behind one accessor | F5, G0.3 |
| 7 | Host → organization resolution, `customDomain`, pre-login white-label | F3 |
| 8 | Durable job queue + transactional outbox + domain event bus (one project) | F6 + F7 |
| 9 | Notification and delivery router — `notify(user, event, payload)` with channel preference | F8 |
| 10 | Test and observability floor — unit runner for `src/`, error tracking, uptime monitoring | F10 |

### Wave 2 · Commercial — *the only path from lead to revenue without a human*

| # | Epic | Maps to |
|---|---|---|
| 11 | One billing subject: unified entitlement + metering spine (Organization, with Company as a role inside it) | F9 |
| 12 | Stripe self-serve checkout, plans, invoices, proration and dunning | P0 commercial layer |
| 13 | Published pricing page, price calculator and in-product upgrade CTAs wired to the existing 403s | Proof feature 1 |
| 14 | Plan and quota enforcement with a usage dashboard — and enforce the five decorative feature keys | P0 entitlements |

### Wave 3 · Differentiator depth — *the niche nobody else serves*

| # | Epic | Maps to |
|---|---|---|
| 15 | Relationship lifecycle states — pause, re-match, extend, cancel, bench — plus a close-loop survey | Leverage #8 |
| 16 | Canonical skill taxonomy (unblocks matching, talent pool, requisition alerts, skills-gap reporting, semantic AI) | Cross-cutting |
| 17 | Matching engine: bulk cohort matching, weighted criteria with hard rules, draft/approve, explainable scores | P0 matching |
| 18 | Hiring loop closure: interview scheduling → outcome → requisition auto-fill, plus the mentee-facing requisition board | P0 hiring |
| 19 | Berichtsheft oversight: org-wide weekly-report compliance dashboard and export | P0 development |
| 20 | Program structure and survey engine: milestones, drip content, stage-triggered automation, pre/mid/post surveys | P0 development |
| 21 | Analytics depth: custom-pipeline correctness, SOURCE partner outcome panel, ROI and placement economics | P0 analytics |

### Wave 4 · Integrations and AI — *table stakes that unblock named deals*

| # | Epic | Maps to |
|---|---|---|
| 22 | Calendar integrity: meeting reschedule/cancel/delete, complete the Google loop, Outlook/Microsoft 365 | P0 meetings |
| 23 | Platform integrations: working OIDC + enforced SSO, scoped org-bound API keys, webhook delivery log and retries, published Zapier app, scheduled SFTP/CSV ingestion | P0 integrations |
| 24 | AI operations and governance: admin console, per-tenant quota and real `AI_PACKAGE` enforcement, endpoint rate limiting, prompt-injection hardening, EU AI Act posture for candidate ranking | P0 AI + critic §B |

### Wave 5 · Trust and first impression — *cheap, high-ROI, asked before every demo*

| # | Epic | Maps to |
|---|---|---|
| 25 | Trust Center and accessibility conformance: subprocessor register, DPA, pen-test summary, retention policy, EU hosting statement, status page, published WCAG/VPAT statement backed by the zero-violation axe baseline | P0 trust surface |
| 26 | Demo and first-impression readiness: seed the hiring chain (`Requisition`, `Offer`, `InterviewRequest`, `InterviewPanel`, `WeeklyReport`, `DocumentRequirement`), the "Request this mentor" CTA, one-click migration import with dry run | Near-free leverage |

---

*Sources: 16 vendor pricing, product, help-centre and security pages; Capterra, G2, GetApp and
TrustRadius review evidence; UK G-Cloud 13 framework filings; and the code-grounded inventory of this
repository. Pricing survey seeded from
<https://www.mentorgain.com/blog/mentoring-platform-pricing-comparison>. Every third-party price estimate
is labelled as unverified where the vendor does not publish it.*
