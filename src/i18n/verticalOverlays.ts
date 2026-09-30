// Per-vertical terminology overlays (#2354, epic #2348).
//
// coreCRM serves several products from one dictionary. A MARKETING tenant should
// not read "candidate" and "mentee" where it means "lead" — so a vertical may
// override individual dictionary strings through an overlay that is deep-merged
// onto the base translation.
//
// THE NO-OP RULE: INTERNSHIP overrides nothing. Its overlay is empty in every
// locale, so getDictionary(locale, 'INTERNSHIP') deep-merges nothing and returns
// output byte-identical to getDictionary(locale). Today every tenant is
// INTERNSHIP, so the whole overlay layer is invisible for the live product — and
// the many e2e specs that assert exact strings keep passing because they run on
// INTERNSHIP/default orgs.
//
// Overlays are PARTIAL and only ever REPLACE a leaf string that already exists;
// they never add keys (check-i18n enforces both — a typo'd overlay key that
// matches nothing is a silent no-op, so it is a build error instead). The set is
// intentionally small and grows as real marketing surfaces are dressed; it does
// not attempt to translate the whole 4800-key dictionary at once.
//
// How far it has got is measured, not guessed (#2558): scripts/check-i18n.ts
// counts the MARKETING-resolved values that still contain an internship word
// and pins that count, so a new un-overlaid "mentor" string fails the check —
// and an overlay entry here that removes some means lowering the literal there.
// E-mails read this same overlay through src/i18n/emailDictionary.ts, keyed on
// the recipient's org; there is no second terminology layer for mail.

import type { Locale } from './config';
import type { Dictionary } from './dictionaries';
import type { VerticalKey } from '@/lib/verticals';

// The default vertical, inlined as a literal (not imported as a value) so this
// module has NO runtime imports and can therefore be loaded by the plain node
// runner that scripts/check-i18n.ts uses — which is what lets that guard
// validate the overlays. Kept in sync with DEFAULT_VERTICAL in src/lib/verticals.ts
// by the vertical-overlays unit spec, which imports both.
const DEFAULT_VERTICAL: VerticalKey = 'INTERNSHIP';

// A recursively-optional view of the dictionary: an overlay may carry any
// subtree down to a replaced leaf string, and nothing it omits.
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends string ? T[K] : DeepPartial<T[K]>;
};

type LocaleOverlay = DeepPartial<Dictionary>;

// One entry per vertical. INTERNSHIP is present and empty ON PURPOSE — the
// emptiness is the no-op guarantee, and a test asserts it stays empty.
const OVERLAYS: Record<VerticalKey, Record<Locale, LocaleOverlay>> = {
  INTERNSHIP: { en: {}, tr: {}, de: {} },
  MARKETING: {
    en: {
      nav: { candidates: 'Leads', companyInquiries: 'Demo requests', myCompanies: 'My accounts' },
      // The lead detail's relation card (#2557): "Mentorship / Not assigned to a
      // mentor yet / Mentor" on the screen a rep uses most.
      // The role-convert button on the lead detail and the users list (#2557):
      // the role enum is unchanged, only the words — MENTOR is a rep, MENTEE a lead.
      // Bringing the sales team in (#2558): the invite screen, the users list's
      // role labels and filter chips, and the invitation mail itself.
      invite: {
        subtitle: 'Invite sales reps and leads to join',
        connectMentor: 'Assign to this rep (optional)',
        connectMentee: 'Give this lead to the new rep (optional)',
        connectHint: 'Chosen here, the lead is assigned the moment they register — no follow-up step.',
        mentorTitle: 'Invite a lead',
        mentorAutoAssign: 'Whoever registers through your link becomes your lead automatically — no assignment step. The link works once and expires after 7 days.',
      },
      notifications: {
        invitationEmail: {
          roles: { MENTOR: 'a sales rep', MENTEE: 'a lead' },
        },
        events: {
          'interaction.logged': 'A new interaction note was added.',
          'company_interest.mentee': 'A company showed interest in your profile. Your contact person will get in touch with you.',
          'mentorship_request.mentorAssigned': 'You have been assigned a contact person: {mentorName}.',
          'mentorship_request.menteeAssigned': 'A new lead was assigned to you: {menteeName}.',
          'mentorship.mentorChanged': 'Your contact person has changed — {mentorName} is looking after you now.',
          'mentorship.reassignedAway': '{menteeName} was handed over to another rep — your deal with them has ended.',
          'mentorship.assignmentCorrected': '{menteeName} was assigned to you by mistake and is no longer your lead.',
          'mentorship.bulkAssigned': 'New leads assigned to you: {count}.',
          'mentorship.bulkReassignedAway': 'Deals handed over to another rep: {count}.',
          'mentorship.autoLinkSkipped': '{name} registered through an invitation, but the pre-linked lead already has a rep — no deal was created.',
          'role_changed.toMentor': 'An administrator converted your account to a sales rep account.',
          'role_changed.toMentee': 'An administrator converted your account to a lead account.',
        },
        // The assignment mails (#2558): the rep is asked to book a demo; the
        // lead is a customer and gets a contact person, not a mentor.
        menteeAssignedEmail: {
          subject: 'New lead assigned: {mentee}',
          heading: 'You have a new lead',
          body: '{mentee} has been assigned to you as a lead. Reach out to them to set up a demo, and log your first interaction when you do.',
          cta: 'Open your sales dashboard',
        },
        mentorAssignedEmail: {
          subject: 'Your contact person: {mentor}',
          heading: 'You have a personal contact person',
          body: '{mentor} is now your personal contact person. Write to them any time — for a demo, your trial or any question about connecting your marketplaces.',
          cta: 'Open your messages',
        },
        mentorDigestEmail: {
          subject: 'Your weekly sales summary',
          stale: '{n} lead(s) with no interaction in 14+ days',
          newApplications: '{n} new lead(s) in the last 7 days',
        },
        activityDigestEmail: {
          subject: 'Daily lead activity',
          subjectAll: 'Daily lead activity (all leads)',
          heading: 'Daily lead activity',
          greetingMentor: 'Hi {name}, here is what your leads did in the last 24 hours:',
          greetingAdmin: 'Hi {name}, system-wide lead activity in the last 24 hours:',
          trackingNote: 'Time-on-site and page views are shown only for leads who enabled activity tracking.',
          columns: { mentee: 'Lead' },
        },
      },
      usersAdmin: {
        mentor: 'Rep',
        mentee: 'Lead',
        makeMentor: 'Make rep',
        makeMentee: 'Make lead',
        convertToMentorConfirm: '{name} will be signed out of every device and becomes a rep at their next sign-in. Their existing records are kept.',
        convertToMenteeConfirm: '{name} will be signed out of every device and becomes a lead at their next sign-in. Their existing records are kept.',
        stateNoLoginHint: 'A record created by a rep or an import. It has no password, so nobody can sign in as it.',
      },
      candidateDetail: {
        mentorship: 'Owner',
        notAssigned: 'No rep owns this lead yet',
        mentor: 'Rep',
      },
      // The suggested first messages in an empty thread (#2557). The rep's set
      // (welcome/introCall/goals) and the lead's set (hello/intro/question) keep
      // their `{name}` placeholder; the words are a sales conversation about a
      // SaleVali demo and trial, not an internship.
      messages: {
        openers: {
          welcome: {
            label: '👋 Welcome',
            text: 'Hi {name}, thanks for your interest in SaleVali! I am your contact from here on — write to me in this chat whenever something comes up.',
          },
          introCall: {
            label: 'Book a demo',
            text: 'Hi {name}, shall we do a short demo? Which days and times work for you this week?',
          },
          goals: {
            label: 'Ask about needs',
            text: 'Hi {name}, before the demo I would like to hear which marketplaces you sell on and what you want to get out of the trial.',
          },
          intro: {
            label: 'Introduce our shop',
            text: 'Hi {name}, let me introduce our shop briefly: ',
          },
        },
        listSubtitle: 'Your conversations',
      },
      // The demo form on the marketing landing and the list its requests land
      // in (#2569). The form is the internship enquiry form re-used; these are
      // the strings that would otherwise talk about hiring and invitations.
      forCompanies: {
        submit: 'Request a demo',
        successBody: 'Your request reached our sales team. We answer within two working days to find a time for the demo.',
      },
      companyInquiriesAdmin: {
        title: 'Demo requests',
        subtitle: 'Requests from the demo form on your website. A request with a default lead owner is already on the pipeline; the rest wait here, unowned, until an admin adds them.',
        emptyTitle: 'No requests waiting',
        emptyBody: 'Demo requests from your website land here, and every admin is notified by email as they arrive.',
      },
      candidates: {
        title: 'Leads',
        subtitle: 'Browse and search leads',
        // `mentor` is the "Mentor: {name}" line on a candidate row AND inside the
        // person hover card, which the board renders on every card's owner chip.
        mentor: 'Rep',
        mineFilter: 'My accounts',
        // The bulk control assigns the person `mentor` above names, so it says
        // the same word — the action key stays `assignOwner` (#2439), only the
        // label follows the vertical.
        bulkOwnerLabel: 'Rep',
        bulkAssignOwner: 'Assign rep',
      },
      // Public chrome + auth pages (#2501): the header aria-label, footer
      // tagline and sign-in/register copy a marketing visitor reads.
      publicNav: {
        homeLink: 'SaleVali — go to the home page',
        tagline: 'Leads, accounts and deals in one pipeline — from first contact to close.',
      },
      auth: {
        signinSubtitle: 'Sign in to your SaleVali account',
        registerSubtitle: 'Register with your invitation',
        tokenHint: 'Paste the invitation token from your e-mail. Accounts on this product are created by invitation.',
      },
      // The admin dashboard (#2498). People = leads, the pipeline relation = a
      // deal — so "mentee/mentor/mentorship" become "lead/rep/deal" and nothing
      // reads "internship" to a marketing tenant.
      dashboard: {
        subtitle: 'Overview of your marketing pipeline',
        mentees: 'Leads',
        mentors: 'Reps',
        activeMentorships: 'Active deals',
        perStage: 'Leads per stage',
        recentMentorships: 'Recent deals',
        latestAssignments: 'Latest deals',
        noMentorships: 'No deals yet',
        newCandidates: 'New Leads',
        recentlyRegistered: 'Recently added leads',
        noCandidates: 'No leads yet',
        quickActions: { browseCandidates: 'Browse Leads' },
      },
      checklist: {
        steps: {
          inviteMentors: 'Invite your first reps',
          inviteMentees: 'Add your first leads',
          assignMentorship: 'Create the first deal',
        },
      },
      // Lead attribution on /admin/analytics (#2421). `cohortTotal`/`cohortHired`
      // are the shared column headers of both the attribution and the cohort
      // table, so overriding them dresses the two consistently. `cohortHired` is
      // only a FALLBACK on the attribution table: a tenant that named its own
      // finished stage sees that name instead (#1882).
      // A rep's own /account page (#2558): the e-mail preference groups, the
      // notification categories and the activity-tracking consent all named
      // mentors. The group KEYS (mentorship_lifecycle…) are storage and stay.
      emailGroups: {
        direct_messages: { desc: 'A real person wrote to you: an in-app message, or a colleague’s e-mail to you directly.' },
        mentorship_lifecycle: { name: 'Lead milestones', desc: 'A lead you own changed — requests, decisions and assignments.' },
        digests: { desc: 'Periodic roll-ups: unread messages, daily activity, the weekly rep digest.' },
        inbound_requests: { desc: 'Someone is asking something of you: a contact form, a demo request, a join request.' },
      },
      account: {
        notifCategories: { mentorship: 'Lead updates' },
        expertiseHint: 'One per line or comma-separated — used to route leads to you',
        capacity: 'Lead capacity',
        capacityHint: 'Max leads you can own at once (blank = no limit)',
        activeMentees: '{count} / {capacity} active leads',
        acceptingMentees: 'I can take on a new lead',
      },
      consent: {
        items: {
          activityTracking: {
            desc: 'Allow recording which pages you visit and how long you spend, so your admins can see a detailed activity report. Off by default; only in-app navigation is recorded — never keystrokes or page content.',
          },
          mentorDirectoryVisibility: {
            title: 'Listing in the contact directory',
            desc: 'Show my profile in the directory of contact people. Shown: name, expertise, languages, capacity status and bio — never your e-mail, phone or lead list. You can withdraw at any time; your card disappears immediately.',
          },
          aiInteractionSummary: { desc: 'Allow your rep to generate an AI summary of the interaction log they keep about your deal. Only the log text is sent to the AI provider — never files or contact details. Off by default.' },
        },
      },
      settings: {
        reminderDaysHint: 'Remind a rep after this many days without a logged interaction',
        weeklyDigest: 'Send the weekly rep digest',
        outcomeAutoSendHint: 'Off by default. When off, reaching an outcome stage notifies the rep and prefills a draft they read, edit and send. When on, the templated message goes to the lead without review — a rejection cannot be recalled.',
        require2faAdminsMentors: 'Required for admins and reps',
        aiMonthlyQuotaHint: 'How many calls to the AI provider may be made per calendar month. Every AI feature draws on the same pool; only a call that actually succeeded is counted, and the counter resets on the 1st. Usage is metered across the whole installation rather than per organisation, so on a shared installation every organisation spends from the same month’s pool. Once it is spent the AI gate refuses further calls until next month — nothing else in the app is affected. 0 switches AI off entirely.',
        // The import card (#2552 review): the second mode is the legacy people
        // importer, shown next to the account import; it creates MENTEE rows — a
        // MARKETING org's leads — so the card says people.
        bulkImport: 'Bulk import people',
        importModeMentees: 'People (leads)',
      },
      analytics: {
        subtitle: 'Funnel, rep workload and activity insights',
        cohortTotal: 'Leads',
        cohortHired: 'Won',
        sourceConversionTitle: 'Conversion by source',
        sourceConversionEmpty: 'No sources yet — assign leads a source to see conversion per source.',
        sourceUnsourced: '{n} lead(s) have no source and are not shown above.',
        // #2573: the drop-off card lists the MARKETING loss reasons (PRICE,
        // COMPETITOR, …) — a sales admin reads lost deals, not drop-offs.
        aging: {
          dropReasonsTitle: 'Loss reasons',
          dropReasonsEmpty: 'No lost deals recorded yet.',
        },
        funnelKpi: {
          capacity: 'Rep capacity',
          capacityHint: 'Active leads against the ceiling each rep set. Status comes from the same rule the assignment screen uses.',
          mentor: 'Rep',
        },
        mentorWorkload: 'Rep workload & outcomes',
        interns: 'members',
        trendNewRelations: 'New deals',
        cohortInteractions: 'Interactions / lead',
      },
      // #2573: the reason dialog shown before a deal moves off the funnel.
      dropoff: {
        dialogHint: 'This stage is off the normal path — a reason keeps the loss analytics meaningful.',
      },
      // The company list (#2426, story #2394). A marketing tenant's companies
      // are the ACCOUNTS it sells to: the relation counter is a deal, a
      // CompanyNeed is what the account needs, and a company login follows its
      // leads. "Companies" itself stays — the Company model is the account
      // master in both products, and the nav says the same word.
      //
      // This is the WHOLE of `companiesPage` whose English still reads like the
      // internship product ("…their internship needs", "mentorships",
      // "positions", "its linked candidates"). Every other key in the namespace
      // is either neutral (title, search, the failure toasts) or names a field
      // that means the same thing in both products, so it is left alone — an
      // overlay entry that changes nothing is noise the next reader has to
      // re-derive.
      // The account detail page (#2560): the funnel records are deals owned
      // by a rep, and a CompanyNeed is what the account needs.
      companyDetail: {
        sections: { funnel: 'Deals', needs: 'Open needs' },
        funnel: {
          person: 'Lead',
          owner: 'Rep',
          empty: 'No deals on this account yet.',
          continues: 'Continues an earlier deal owned by {name}',
        },
        needsEmpty: 'No needs recorded.',
        // The external id is what the usage feed keys on (#2560) — a MARKETING-only notion.
        externalId: { hint: 'The id this account carries in the product you sell. It is how usage data finds this account, so it must be unique within your organization.' },
      },
      companiesPage: {
        subtitle: 'Manage the accounts you sell to and what each one needs',
        addLoginHint: 'Create a read-only login for a company to follow its linked leads.',
        mentorships: 'deals',
        positions: 'needs',
        openPositions: 'Open needs',
        // The delete dialog (#2441) is this page's THIRD dialog, and the same
        // acceptance covers it: it names the dependants of the account being
        // deleted, so a marketing admin was reading "1 mentorships" and "1 open
        // positions" one click before an irreversible action.
        //
        // Three of the twelve labels are overridden, for the same reason as
        // above — the rest name the same thing in both products
        // (`entitlements`, `needAlerts`, `projects`, `users`, `fromInquiries`)
        // or belong to the `placements` capability a MARKETING tenant does not
        // carry (`requisitions`, `interviewRequests`, `offers`, `placements`),
        // and are left alone rather than translated speculatively.
        deleteDialog: {
          labels: { needs: 'open needs', interests: 'lead interests', mentorships: 'deals' },
        },
      },
      // The two DIALOGS /admin/companies opens are part of that page, so the
      // acceptance ("no mentorship word on /admin/companies") covers them: the
      // create/edit form — whose empty-state CTA is the first control a day-one
      // tenant clicks — and the premium-features modal behind the Sparkles
      // button on every card. Only the keys whose English still names the
      // internship product are overridden; the rest of both namespaces is field
      // labels that mean the same thing in either product.
      companyForm: {
        quota: 'Need quota',
        needs: 'Account needs',
        noNeeds: 'No needs added yet. Click "Add Need" to record what this account needs.',
      },
      entitlements: {
        subtitle: 'Enable premium features for {name}. Rep and lead features are always free.',
      },
      // The stage board (#2427): every card is a lead owned by a rep, the pair
      // is a deal.
      //
      // Stage NAMES need nothing here, deliberately: a MARKETING org is
      // provisioned with MARKETING_FUNNEL (provisionStagePreset), whose stages
      // carry their own en/tr/de labels that stageLabel() resolves. A second
      // translation layer for stage names is exactly what #2427 rules out.
      //
      // `board.emptyStage` has no reader in src today — the admin board renders
      // an empty column rather than a message. It is overridden anyway: the key
      // is live in all three locales, and whoever renders it next must not
      // reintroduce "No mentees in this stage" on a marketing board.
      //
      // The group headings need all three: MARKETING_FUNNEL's keys are its own
      // (LEAD_*/DEAL_*), so groupResolvedStages() files every one of them under
      // `custom` — that is the ONE heading a provisioned marketing tenant
      // actually sees, and "Custom stages" describes a deviation from a
      // programme it does not run. `pre`/`internship` still get an override
      // because an org switched to MARKETING while sitting on the canonical
      // stage keys renders them, and those two read "Pre-internship"/"Internship".
      board: { emptyStage: 'No leads in this stage' },
      adminBoard: {
        subtitle: 'Every lead across every rep — drag a card, or use the stage menu on it, to change its stage',
        searchPlaceholder: 'Find a lead or rep...',
        wipSaturated: 'Every column on this board is over its work-in-progress limit, so the amber warning no longer points anywhere and is hidden. Set a limit that matches how this pipeline actually runs — one number for the board, or one per stage.',
        groups: { pre: 'Leads', internship: 'Deals', custom: 'Funnel' },
      },
      // PersonHoverCard is shared chrome, but the board opens one on EVERY
      // card's owner chip (hover, tap or keyboard focus), and it announces the
      // person's role — so "Mentor"/"Mentee" are on the very screen #2427
      // names. These are the same two words `dashboard.mentors`/`mentees`
      // already rename, so the decision is not a new one. The rest of the
      // namespace (admin/company/source, "Open profile", "Message") is neutral
      // and left alone.
      personCard: { roleMentor: 'Rep', roleMentee: 'Lead' },
      // The sales rep's surface at /sales (#2580). It exists only in a vertical
      // without mentorship, and the board it renders is the mentor board, so
      // the few mentor.* strings that board reads are dressed here too — they
      // are never shown by a mentor shell in this vertical, which has none.
      panel: { sales: 'Sales' },
      sales: {
        dashboard: { title: 'Your sales pipeline', subtitle: 'Your own leads and accounts, and what needs you today.' },
        stats: { open: 'Open leads', accounts: 'Accounts' },
        records: {
          title: 'My leads',
          empty: 'No leads are assigned to you yet. An admin — or the default lead owner setting — assigns them to you.',
          person: 'Lead',
          company: 'Account',
        },
        accounts: {
          title: 'My accounts',
          subtitle: 'The accounts behind your own leads.',
          empty: 'None of your leads is linked to an account yet.',
          name: 'Account',
          records: 'Your leads',
          back: 'My accounts',
        },
        lead: { back: 'My leads', company: 'Account' },
      },
      mentor: {
        boardSubtitle: 'Your leads by stage — drag a card, or use its stage menu, to move it',
        menteeBoardSearchPlaceholder: 'Find a lead...',
        noMatchingMentees: 'No leads match this filter',
      },
      // The day-one empty states of the same two screens (both rendered by the
      // pages #2426/#2427 name, so the acceptance "no mentorship word on
      // /admin/companies or the board" is not met without them): a fresh tenant
      // reads these before anything else, so they must not explain internships.
      emptyStates: {
        board: {
          adminBody: 'Every deal shows up here as a card, in the stage it has reached. Add the first leads and their cards appear as soon as a rep owns them.',
          // The rep's own board on /sales (#2580).
          mentorBody: 'Your leads appear here as cards once they are assigned to you.',
        },
        companies: {
          adminBody: 'Companies are the accounts you sell to: once one exists you can attach what it needs, its contact people and the deals open against it.',
        },
      },
      landing: {
        // The lean marketing landing (#2500): the sections that survive for a
        // MARKETING host — hero, chips, feature cards, the funnel diagram, "and
        // more", transparency, CTA — re-worded for a sales team. The internship
        // argument (loop, role picker, audiences, free core, how-it-works, roles,
        // stories, FAQ) is not rendered for this vertical, so it is not overlaid.
        chipStages: 'One pipeline from lead to closed deal',
        chipRoles: 'Open source — AGPL-3.0',
        chipLangs: 'English · Türkçe · Deutsch',
        chipGdpr: 'Your customer data stays yours',
        fPipelineT: 'Pipeline tracking',
        fPipelineD: 'Every lead on one board, from new to won or lost — drag-and-drop stages, a deadline per stage with overdue flags, and a full history of who moved what and when.',
        fCompanyT: 'Accounts & contacts',
        fCompanyD: 'Track the companies you sell to and the people inside them — add a new account and its lead in one step, log what each account needs, and see every open deal against it in one place.',
        fCommsT: 'Communication',
        fCommsD: 'Meeting invites with RSVP, in-app messaging on every deal, single and bulk emails, announcements, per-category notification preferences, reminders and a weekly digest.',
        fDocsT: 'Documents & templates',
        fDocsD: 'Versioned uploads on any lead or account, a multilingual template library for proposals and follow-ups with in-app preview and PDF export.',
        fAnalyticsT: 'Analytics & insights',
        fAnalyticsD: 'Conversion funnel, time and ageing per stage, deals per rep and their outcomes, six-month trends with a date-range selector.',
        fPrivacyT: 'Access & privacy',
        fPrivacyD: 'Role-based access, two-factor authentication, email verification, an activity log, and a full GDPR toolkit: consent, retention reminders, erasure and one-click data export.',
        fPlatformT: 'A pleasant place to work',
        fPlatformD: 'Three languages (EN/TR/DE), dark mode, adjustable font size, global search, installable as an app (PWA) with offline support, and a public “What’s new” page.',
        pipelineTitle: 'From first contact to closed deal',
        pipelineSubtitle: 'Every lead moves through the same stages, so you always know where a deal stands and what the next step is.',
        pipelineStagesNote: 'Under the hood: seven granular stages — from new lead to won or lost — with a service level per stage and overdue flags.',
        pipelineNote: 'Not every lead closes: lost deals are recorded too, so the funnel tells you the truth.',
        stageApply: 'New lead',
        stageInterview: 'Contacted',
        stageInternship: 'Proposal sent',
        stageHired: 'Won',
        moreTitle: 'And a lot more',
        moreSubtitle: 'A quick sample of what else ships out of the box.',
        more1: 'Add a lead by hand, or import leads from CSV and export them to Excel',
        more2: 'Saved views, filters and fast server-side pagination',
        more3: 'Tags to slice leads and accounts any way you like',
        more4: 'Read-only REST API with OpenAPI spec, API keys and signed webhooks',
        more5: 'Calendar with ICS feed, availability slots and meeting requests',
        more6: 'Duplicate detection and one-click merge for leads',
        more7: 'Invitation lifecycle tracking for your team (sent → opened → registered → verified)',
        more8: 'Accessibility: adjustable font size, skip links and visible focus rings',
        ctaTitle: 'Ready to see every deal in one place?',
        ctaSubtitle: 'Set up your pipeline in minutes — your team signs in with an invitation.',
        ctaMentee: 'Sign in',
        ctaFootnote: 'Open source, AGPL-3.0 — the code is on GitHub.',
        trans5T: 'Consent as a mechanism',
        trans5D: 'Customer data is shown to nobody outside your team; every consent is recorded with its version and revocable at any time. Email and phone never appear on any public page.',
        transBeta: 'And the honest part: the marketing product is in early access, built by a small team, with no customer testimonials yet. We would rather you read that here than find it out later.',
        founderBody: 'SaleVali is built and maintained by {name} — one person, in the open, on the same core that runs a mentoring platform for hundreds of people. Questions and criticism are welcome.',
        badge: 'Marketing CRM · Track leads · Close deals',
        heroTitle: 'Every lead, every conversation, every deal —',
        heroAccent: 'in one pipeline.',
        heroSubtitle: 'Track your customers from first contact to close. See where every deal stands, who touched it last and what to do next — instead of piecing it together from a spreadsheet.',
        featuresTitle: 'Everything your team needs to close',
        featuresSubtitle: 'Purpose-built for tracking customers and moving deals forward.',
      },
      // The public feature catalogue (#2475). `/features` renders whatever
      // getFeatures() returns for this vertical; the cards themselves are
      // filtered by capability in src/lib/features.ts, and what is left here is
      // the frame plus the four core cards whose wording still said
      // "mentor"/"mentee"/"mentorship" although the feature itself is core CRM.
      featureCatalog: {
        title: 'Everything SaleVali can do',
        subtitle: 'The full feature catalogue — from first contact to a closed deal, for your whole team.',
        categories: { collaboration: 'Working together' },
        items: {
          // `messaging` carries no capability tag — a shared inbox is core CRM
          // and MARKETING has it — so the capability filter cannot reach this
          // card, and its wording was the last place a marketing visitor read
          // the internship relation model on /features: "per-mentorship
          // threads". The thread is per pipeline record, which is a deal here.
          messaging: { d: 'A unified inbox with a thread per deal, attachments and email mirroring you can reply to — answer the notification from your mail app and it lands back in the thread. Messages arrive live while the inbox is open, and can notify your device even when the app is closed. A half-written reply is kept per conversation until you send it, and you can see when the other person is writing. The answers you give over and over live in a shared pool of canned responses — written once in English, Turkish and German, inserted in your own language, one click.' },
          videoCalls: { d: 'Start a call with a lead, an account team or a chat in one click and hold it in a side panel next to their record, on our own Jitsi tenant — no accounts, no install, and no time limit. If a call has to fall back to the free public room, the panel says so before anyone joins, with a one-click way to keep talking. The link is emailed to everyone invited and works in any browser.' },
          externalGuests: { d: 'A meeting is not always only your own team. Type any email address into the scheduler and that person is invited to the same room with the same Yes/No buttons — no account, no sign-up, and an .ics for their own calendar. You see who accepted, and an invitation sent to the wrong address can be withdrawn, which stops its link working.' },
          // `ownWorkspace` is untagged (a mentor's own mentees are the same
          // promise), so the rep's version of it is a sentence here (#2580).
          ownWorkspace: { t: 'A workspace for every sales rep', d: 'Each rep signs in to their own book: their leads and accounts, the follow-ups and trial ends that are due, their own board — and a quick way to log the call they just made. Another rep\u2019s deals, or another organization\u2019s, are not a hidden tab away; they simply do not exist on that page.' },
          inviteLinks: { d: 'Invite someone whose address you do not know: leave the field empty and a single-use, 7-day link is minted to hand over in person. Whoever registers with it is connected to the sender straight away, and a private note keeps a wall of links legible.' },
        },
      },
      // /pricing (#2475). The marketing product has NO published price list —
      // the packaging has not been decided — so the page hides every section
      // that would have to state one (see src/app/pricing/page.tsx) and these
      // strings replace the internship framing of what is left. Nothing here
      // invents a number, a plan or a seat: the two claims that survive are the
      // ones that are true whatever the packaging turns out to be (self-hosting
      // is free; there is no checkout, you get an invoice after a conversation).
      pricing: {
        heroBadge: 'Marketing pricing is not published yet',
        heroTitle: 'What we can tell you about the price today',
        heroSubtitle: 'The packaging for the marketing product has not been set yet, so there is no price list on this page — we would rather show you nothing than a number we would have to take back. What is already true, whatever the packaging turns out to be, is below.',
        discountsTitle: 'What is already true',
      },
      bulkInvite: { roleMentee: 'Lead', roleMentor: 'Sales rep' },
      assignMentor: {
        label: 'Assign a rep',
        chooseMentor: 'Choose a rep…',
        alreadyAssigned: 'This lead already has a rep.',
        suggestHint: 'Suggest the best rep (AI-assisted when available)',
        noSuggestion: 'No available rep to suggest.',
        confirmAtCapacity: 'This rep appears to be at capacity. Assign anyway?',
        confirmNotAccepting: 'This rep has said they are not taking new leads. Assign anyway?',
      },
      roleChangeEmail: {
        subjectMentor: 'Your account is now a sales rep account',
        subjectMentee: 'Your account is now a lead account',
        headingMentor: 'You are a sales rep now',
        headingMentee: 'Your account is now a lead account',
        bodyMentor: 'An administrator converted your account to a sales rep account. You were signed out of all devices; when you sign in again you will land in your sales workspace. Your existing deals and history are untouched.',
        bodyMentee: 'An administrator converted your account to a lead account. You were signed out of all devices; when you sign in again you will land on your account page. Your existing deals and history are untouched.',
      },
      // /admin/settings renders two editors of its own (#2558): the evaluation
      // criteria and the stage service levels. Named for a sales team, not
      // hidden — hiding one is a capability decision, not a string.
      evaluationFramework: {
        subtitle: 'What a deal is scored on. Leave these as they are and the built-in criteria stay in force; define your own and they replace them everywhere evaluations are written and read.',
        onMentee: 'What a rep scores a lead on',
        onMentor: 'What a lead scores a rep on',
      },
      stageSla: {
        subtitle: 'How long anyone may wait at a stage before the rep is warned. Leave a stage empty and it has no rule — an organisation that sets none keeps working exactly as before.',
      },
    },
    tr: {
      // Kişi = müşteri adayı (Lead); pipeline ilişkisi = fırsat (Deal). "Fırsat"
      // bilerek deal için ayrıldı, kişi listesi "Müşteri Adayları" oldu.
      nav: { candidates: 'Müşteri Adayları', companyInquiries: 'Demo talepleri', myCompanies: 'Hesaplarım' },
      invite: {
        subtitle: 'Satış temsilcilerini ve müşteri adaylarını davet et',
        connectMentor: 'Bu temsilciye ata (isteğe bağlı)',
        connectMentee: 'Bu müşteri adayını yeni temsilciye ver (isteğe bağlı)',
        connectHint: 'Burada seçilirse müşteri adayı, kayıt olduğu anda atanır — ayrıca bir adım gerekmez.',
        mentorTitle: 'Müşteri adayı davet et',
        mentorAutoAssign: 'Bağlantınla kaydolan kişi otomatik olarak senin müşteri adayın olur — ayrıca atama yapman gerekmez. Bağlantı tek kullanımlıktır ve 7 gün sonra geçersiz olur.',
      },
      notifications: {
        invitationEmail: {
          roles: { MENTOR: 'satış temsilcisi', MENTEE: 'müşteri adayı' },
        },
        events: {
          'interaction.logged': 'Yeni bir etkileşim kaydı eklendi.',
          'company_interest.mentee': 'Bir firma profilinle ilgilendi. Muhatabın seninle iletişime geçecek.',
          'mentorship_request.mentorAssigned': 'Sana bir muhatap atandı: {mentorName}.',
          'mentorship_request.menteeAssigned': 'Sana yeni bir müşteri adayı atandı: {menteeName}.',
          'mentorship.mentorChanged': 'Muhatabın değişti — artık {mentorName} seninle ilgileniyor.',
          'mentorship.reassignedAway': '{menteeName} başka bir temsilciye devredildi — onunla fırsatın sona erdi.',
          'mentorship.assignmentCorrected': '{menteeName} yanlışlıkla sana atanmıştı; artık senin müşteri adayın değil.',
          'mentorship.bulkAssigned': 'Sana atanan yeni müşteri adayı sayısı: {count}.',
          'mentorship.bulkReassignedAway': 'Başka bir temsilciye devredilen fırsat sayısı: {count}.',
          'mentorship.autoLinkSkipped': '{name} bir davetle kayıt oldu, ancak ön-eşleştirilen müşteri adayının zaten bir temsilcisi var — fırsat oluşturulmadı.',
          'role_changed.toMentor': 'Bir yönetici hesabını satış temsilcisi hesabına dönüştürdü.',
          'role_changed.toMentee': 'Bir yönetici hesabını müşteri adayı hesabına dönüştürdü.',
        },
        menteeAssignedEmail: {
          subject: 'Yeni müşteri adayı atandı: {mentee}',
          heading: 'Yeni bir müşteri adayınız var',
          body: '{mentee} size müşteri adayı olarak atandı. Bir demo ayarlamak için iletişime geçin ve ilk etkileşiminizi kaydetmeyi unutmayın.',
          cta: 'Satış panonuzu açın',
        },
        // Müşteri adayına gider: siz diliyle.
        mentorAssignedEmail: {
          subject: 'Muhatabınız: {mentor}',
          heading: 'Size bir muhatap atandı',
          body: '{mentor} artık sizin muhatabınız. Demo, deneme süreciniz ya da pazaryeri bağlantılarınızla ilgili her sorunuzda ona buradan yazabilirsiniz.',
          cta: 'Mesajlarınızı açın',
        },
        mentorDigestEmail: {
          subject: 'Haftalık satış özetiniz',
          stale: '14+ gündür etkileşim olmayan {n} müşteri adayı',
          newApplications: 'Son 7 günde {n} yeni müşteri adayı',
        },
        activityDigestEmail: {
          subject: 'Günlük müşteri adayı etkinliği',
          subjectAll: 'Günlük müşteri adayı etkinliği (tüm müşteri adayları)',
          heading: 'Günlük müşteri adayı etkinliği',
          greetingMentor: 'Merhaba {name}, müşteri adaylarınızın son 24 saatte yaptıkları:',
          greetingAdmin: 'Merhaba {name}, son 24 saatteki sistem geneli müşteri adayı etkinliği:',
          trackingNote: 'Sitede geçirilen süre ve sayfa görüntülemeleri yalnızca etkinlik takibini açan müşteri adayları için gösterilir.',
          columns: { mentee: 'Müşteri adayı' },
        },
      },
      usersAdmin: {
        mentor: 'Temsilci',
        mentee: 'Müşteri adayı',
        makeMentor: 'Temsilci yap',
        makeMentee: 'Müşteri adayı yap',
        convertToMentorConfirm: '{name} tüm cihazlardan çıkış yaptırılır ve bir sonraki girişinde temsilci olur. Mevcut kayıtları korunur.',
        convertToMenteeConfirm: '{name} tüm cihazlardan çıkış yaptırılır ve bir sonraki girişinde müşteri adayı olur. Mevcut kayıtları korunur.',
        stateNoLoginHint: 'Bir temsilci veya içe aktarma tarafından oluşturulmuş kayıt. Parolası yok, kimse bu hesapla giriş yapamaz.',
      },
      candidateDetail: {
        mentorship: 'Sorumlu',
        notAssigned: 'Bu müşteri adayı henüz bir temsilciye atanmadı',
        mentor: 'Temsilci',
      },
      messages: {
        openers: {
          welcome: {
            label: '👋 Hoş geldiniz',
            text: 'Merhaba {name}, SaleVali\'ye gösterdiğiniz ilgi için teşekkürler! Bundan sonra muhatabınız benim — aklınıza takılan her şeyi bu sohbetten yazabilirsiniz.',
          },
          introCall: {
            label: 'Demo ayarla',
            text: 'Merhaba {name}, kısa bir demo yapalım mı? Bu hafta hangi gün ve saatler size uygun?',
          },
          goals: {
            label: 'İhtiyaçları sor',
            text: 'Merhaba {name}, demodan önce hangi pazaryerlerinde satış yaptığınızı ve denemeden ne beklediğinizi öğrenmek isterim.',
          },
          intro: {
            label: 'Mağazamızı tanıtayım',
            text: 'Merhaba {name}, mağazamızı kısaca tanıtmak isterim: ',
          },
        },
        listSubtitle: 'Yazışmaların',
      },
      forCompanies: {
        submit: 'Demo isteyin',
        successBody: 'Talebiniz satış ekibimize ulaştı. Demo için bir zaman bulmak üzere iki iş günü içinde dönüyoruz.',
      },
      companyInquiriesAdmin: {
        title: 'Demo talepleri',
        subtitle: 'Web sitenizdeki demo formundan gelen talepler. Varsayılan aday sahibi varsa talep zaten hatta; yoksa bir yönetici ekleyene kadar burada sahipsiz bekler.',
        emptyTitle: 'Bekleyen talep yok',
        emptyBody: 'Web sitenizden gelen demo talepleri buraya düşer ve geldikçe tüm yöneticilere e-postayla bildirilir.',
      },
      candidates: {
        title: 'Müşteri Adayları',
        subtitle: 'Müşteri adaylarını görüntüle ve ara',
        mentor: 'Temsilci',
        mineFilter: 'Benim müşterilerim',
        bulkOwnerLabel: 'Temsilci',
        bulkAssignOwner: 'Temsilci ata',
      },
      publicNav: {
        homeLink: 'SaleVali — ana sayfaya git',
        tagline: 'Müşteri adayları, firmalar ve anlaşmalar tek hatta — ilk temastan kapanışa.',
      },
      auth: {
        signinSubtitle: 'SaleVali hesabınıza giriş yapın',
        registerSubtitle: 'Davetinizle kaydolun',
        tokenHint: 'E-postanızdaki davet kodunu yapıştırın. Bu üründe hesaplar davetle açılır.',
      },
      dashboard: {
        subtitle: 'Pazarlama hattınıza genel bakış',
        mentees: 'Müşteri Adayları',
        mentors: 'Temsilciler',
        activeMentorships: 'Aktif fırsatlar',
        perStage: 'Aşama başına aday',
        recentMentorships: 'Son fırsatlar',
        latestAssignments: 'Son eklenen fırsatlar',
        noMentorships: 'Henüz fırsat yok',
        newCandidates: 'Yeni Müşteri Adayları',
        recentlyRegistered: 'Son eklenen müşteri adayları',
        noCandidates: 'Henüz müşteri adayı yok',
        quickActions: { browseCandidates: 'Müşteri adaylarını görüntüle' },
      },
      checklist: {
        steps: {
          inviteMentors: 'İlk temsilcilerini davet et',
          inviteMentees: 'İlk müşteri adaylarını ekle',
          assignMentorship: 'İlk fırsatı oluştur',
        },
      },
      emailGroups: {
        direct_messages: { desc: 'Sana gerçek bir insan yazdı: uygulama içi bir mesaj ya da bir çalışma arkadaşının doğrudan e-postası.' },
        mentorship_lifecycle: { name: 'Müşteri adayı kilometre taşları', desc: 'Sorumlu olduğun bir müşteri adayında bir şey değişti — talepler, kararlar ve atamalar.' },
        digests: { desc: 'Belirli aralıklarla gelen toplu özetler: okunmamış mesajlar, günlük hareketler, haftalık temsilci özeti.' },
        inbound_requests: { desc: 'Biri senden bir şey istiyor: iletişim formu, demo talebi, katılma isteği.' },
      },
      account: {
        notifCategories: { mentorship: 'Müşteri adayı güncellemeleri' },
        expertiseHint: 'Her satıra bir tane ya da virgülle ayrılmış — müşteri adaylarının sana yönlendirilmesinde kullanılır',
        capacity: 'Müşteri adayı kapasitesi',
        capacityHint: 'Aynı anda sahip olabileceğin maksimum müşteri adayı (boş = limitsiz)',
        activeMentees: '{count} / {capacity} aktif müşteri adayı',
        acceptingMentees: 'Yeni müşteri adayı alabilirim',
      },
      consent: {
        items: {
          activityTracking: {
            desc: 'Hangi sayfaları ziyaret ettiğinin ve ne kadar kaldığının kaydedilmesine izin ver; yöneticilerin ayrıntılı bir etkinlik raporu görebilsin. Varsayılan olarak kapalı; yalnızca uygulama içi gezinme kaydedilir — tuş vuruşları ya da sayfa içeriği asla.',
          },
          mentorDirectoryVisibility: {
            title: 'Muhatap dizininde listelenme',
            desc: 'Profilimi muhataplar dizininde göster. Gösterilenler: ad, uzmanlık, diller, kapasite durumu ve tanıtım — e-posta, telefon veya müşteri adayı listen asla gösterilmez. İstediğin an geri çekebilirsin; kartın anında kaybolur.',
          },
          aiInteractionSummary: { desc: 'Temsilcinin, fırsatınla ilgili tuttuğu etkileşim kayıtlarının AI özetini oluşturmasına izin ver. AI sağlayıcısına yalnızca kayıt metni gönderilir — dosyalar veya iletişim bilgileri asla. Varsayılan olarak kapalıdır.' },
        },
      },
      settings: {
        reminderDaysHint: 'Bu kadar gün etkileşim kaydedilmezse temsilciye hatırlat',
        weeklyDigest: 'Haftalık temsilci özetini gönder',
        outcomeAutoSendHint: 'Varsayılan olarak kapalı. Kapalıyken sonuç aşamasına ulaşılınca temsilci bilgilendirilir ve okuyup düzenleyip göndereceği bir taslak hazırlanır. Açıkken şablon mesaj incelenmeden müşteri adayına gider — bir ret geri alınamaz.',
        require2faAdminsMentors: 'Yöneticiler ve temsilciler için zorunlu',
        aiMonthlyQuotaHint: 'Bir takvim ayında yapay zekâ sağlayıcısına kaç çağrı yapılabileceği. Tüm yapay zekâ özellikleri aynı havuzdan harcar; yalnızca başarılı olan çağrı sayılır ve sayaç ayın 1\'inde sıfırlanır. Kullanım kurum başına değil tüm kurulum genelinde ölçülür; paylaşılan bir kurulumda her kurum aynı ayın havuzundan harcar. Havuz bitince yapay zekâ kapısı bir sonraki aya kadar yeni çağrıları reddeder — uygulamanın geri kalanı etkilenmez. 0 yapay zekâyı tamamen kapatır.',
        // The import card (#2552 review): the second mode is the legacy people
        // importer, shown next to the account import; it creates MENTEE rows — a
        // MARKETING org's leads — so the card says people.
        bulkImport: 'Toplu kişi içe aktar',
        importModeMentees: 'Kişiler (lead)',
      },
      analytics: {
        subtitle: 'Satış hunisi, temsilci iş yükü ve etkinlik içgörüleri',
        cohortTotal: 'Müşteri adayı',
        cohortHired: 'Kazanılan',
        sourceConversionTitle: 'Kaynağa göre dönüşüm',
        sourceConversionEmpty: 'Henüz kaynak yok — kaynak bazlı dönüşümü görmek için müşteri adaylarına kaynak ata.',
        sourceUnsourced: '{n} müşteri adayının kaynağı yok ve yukarıda gösterilmiyor.',
        aging: {
          dropReasonsTitle: 'Kayıp nedenleri',
          dropReasonsEmpty: 'Henüz kaybedilen fırsat kaydı yok.',
        },
        funnelKpi: {
          capacity: 'Temsilci kapasitesi',
          capacityHint: 'Her temsilcinin belirlediği tavana karşı aktif müşteri adayı sayısı. Durum, atama ekranının kullandığı kuralın aynısından geliyor.',
          mentor: 'Temsilci',
        },
        mentorWorkload: 'Temsilci yükü & çıktılar',
        interns: 'üye',
        trendNewRelations: 'Yeni fırsat',
        cohortInteractions: 'Etkileşim / müşteri adayı',
      },
      // No `dropoff.dialogHint` here: the base TR hint already says "kayıp analizi".
      companyDetail: {
        sections: { funnel: 'Fırsatlar', needs: 'Açık ihtiyaçlar' },
        funnel: {
          person: 'Müşteri adayı',
          owner: 'Temsilci',
          empty: 'Bu hesapta henüz fırsat yok.',
          continues: '{name} temsilcisindeki önceki fırsatın devamı',
        },
        needsEmpty: 'Kayıtlı ihtiyaç yok.',
        // The external id is what the usage feed keys on (#2560) — a MARKETING-only notion.
        externalId: { hint: 'Bu hesabın sattığınız üründeki kimliği. Kullanım verisi hesabı bununla bulur; bu yüzden kuruluşunuz içinde benzersiz olmalı.' },
      },
      companiesPage: {
        subtitle: 'Sattığın müşteri firmalarını ve ihtiyaçlarını yönet',
        addLoginHint: 'Bir şirketin kendi müşteri adaylarını izlemesi için salt-okunur giriş oluştur.',
        mentorships: 'fırsat',
        positions: 'ihtiyaç',
        openPositions: 'Açık ihtiyaçlar',
        deleteDialog: {
          labels: {
            needs: 'açık ihtiyaç',
            interests: 'müşteri adayı ilgisi',
            mentorships: 'fırsat',
          },
        },
      },
      companyForm: {
        quota: 'İhtiyaç kontenjanı',
        needs: 'Firma ihtiyaçları',
        noNeeds: 'Henüz ihtiyaç eklenmedi. Bu firmanın neye ihtiyacı olduğunu kaydetmek için "İhtiyaç ekle"ye tıkla.',
      },
      entitlements: {
        subtitle: '{name} için premium özellikleri aç. Temsilci ve müşteri adayı özellikleri her zaman ücretsizdir.',
      },
      board: { emptyStage: 'Bu aşamada müşteri adayı yok' },
      adminBoard: {
        subtitle: 'Tüm temsilcilerin tüm müşteri adayları — aşamayı kartı sürükleyerek ya da kartın aşama menüsünden değiştir',
        searchPlaceholder: 'Müşteri adayı veya temsilci bul...',
        wipSaturated: 'Panodaki her sütun kendi iş limitinin üzerinde; bu yüzden turuncu uyarı artık bir yeri işaret etmiyor ve gizlendi. Bu hattın gerçekten nasıl yürüdüğüne uyan bir limit belirle — pano için tek sayı ya da aşama başına birer tane.',
        groups: { pre: 'Müşteri Adayları', internship: 'Fırsatlar', custom: 'Satış hunisi' },
      },
      personCard: { roleMentor: 'Temsilci', roleMentee: 'Müşteri adayı' },
      panel: { sales: 'Satış' },
      sales: {
        dashboard: { title: 'Satış pipeline\'ın', subtitle: 'Kendi müşteri adayların ve hesapların, bugün seni bekleyenler.' },
        stats: { open: 'Açık müşteri adayları', accounts: 'Hesaplar' },
        records: {
          title: 'Müşteri adaylarım',
          empty: 'Henüz sana atanmış bir müşteri adayı yok. Bir yönetici — ya da varsayılan sahip ayarı — atar.',
          person: 'Müşteri adayı',
          company: 'Hesap',
        },
        accounts: {
          title: 'Hesaplarım',
          subtitle: 'Kendi müşteri adaylarının bağlı olduğu hesaplar.',
          empty: 'Müşteri adaylarından hiçbiri henüz bir hesaba bağlı değil.',
          name: 'Hesap',
          records: 'Senin müşteri adayların',
          back: 'Hesaplarım',
        },
        lead: { back: 'Müşteri adaylarım', company: 'Hesap' },
      },
      mentor: {
        boardSubtitle: 'Müşteri adayların aşamaya göre — taşımak için kartı sürükle ya da aşama menüsünü kullan',
        menteeBoardSearchPlaceholder: 'Müşteri adayı bul...',
        noMatchingMentees: 'Bu filtreye uyan müşteri adayı yok',
      },
      emptyStates: {
        board: {
          adminBody: 'Her fırsat burada, ulaştığı aşamada bir kart olarak görünür. İlk müşteri adaylarını ekle; bir temsilci sahiplendiği anda kartları burada belirir.',
          mentorBody: 'Sana atanan müşteri adayları burada kart olarak görünür.',
        },
        companies: {
          adminBody: 'Şirketler sattığın müşteri hesaplarıdır: bir şirket eklediğinde ona ihtiyaçlarını, iletişim kişilerini ve açık fırsatlarını bağlayabilirsin.',
        },
      },
      landing: {
        chipStages: 'Adaydan kapanan anlaşmaya tek hat',
        chipRoles: 'Açık kaynak — AGPL-3.0',
        chipLangs: 'English · Türkçe · Deutsch',
        chipGdpr: 'Müşteri veriniz sizde kalır',
        fPipelineT: 'Hat takibi',
        fPipelineD: 'Her müşteri adayı tek panoda, yeniden kazanıldı ya da kaybedildiye — sürükle-bırak aşamalar, aşama başına son tarih ve gecikme işaretleri, kimin neyi ne zaman taşıdığının tam geçmişi.',
        fCompanyT: 'Firmalar & kişiler',
        fCompanyD: 'Sattığınız firmaları ve içindeki kişileri takip edin — yeni bir firmayı ve müşteri adayını tek adımda ekleyin, her firmanın ihtiyacını kaydedin, açık fırsatların hepsini tek yerde görün.',
        fCommsT: 'İletişim',
        fCommsD: 'RSVP’li toplantı davetleri, her fırsatta uygulama içi mesajlaşma, tekil ve toplu e-posta, duyurular, kategori bazlı bildirim tercihleri, hatırlatmalar ve haftalık özet.',
        fDocsT: 'Belgeler & şablonlar',
        fDocsD: 'Her aday ve firmada sürümlü yüklemeler; teklif ve takip yazıları için çok dilli şablon kütüphanesi, uygulama içi önizleme ve PDF dışa aktarma.',
        fAnalyticsT: 'Analitik & içgörü',
        fAnalyticsD: 'Dönüşüm hunisi, aşama başına süre ve yaşlanma, temsilci başına fırsat ve sonuçları, tarih aralığı seçicili altı aylık eğilimler.',
        fPrivacyT: 'Erişim & gizlilik',
        fPrivacyD: 'Rol bazlı erişim, iki adımlı doğrulama, e-posta doğrulaması, etkinlik günlüğü ve tam KVKK/GDPR araç seti: onay, saklama hatırlatmaları, silme ve tek tıkla veri dışa aktarma.',
        fPlatformT: 'Çalışması keyifli bir yer',
        fPlatformD: 'Üç dil (EN/TR/DE), karanlık mod, ayarlanabilir yazı boyutu, genel arama, çevrimdışı destekli uygulama olarak kurulum (PWA) ve herkese açık “Yenilikler” sayfası.',
        pipelineTitle: 'İlk temastan kapanan anlaşmaya',
        pipelineSubtitle: 'Her aday aynı aşamalardan geçer; bir anlaşmanın nerede durduğunu ve sıradaki adımı her zaman bilirsiniz.',
        pipelineStagesNote: 'Arka planda: yeni adaydan kazanıldı ya da kaybedildiye yedi ayrıntılı aşama — aşama başına hizmet seviyesi ve gecikme işaretleri.',
        pipelineNote: 'Her aday kapanmaz: kaybedilen anlaşmalar da kaydedilir, huni size doğruyu söyler.',
        stageApply: 'Yeni aday',
        stageInterview: 'İletişime geçildi',
        stageInternship: 'Teklif gönderildi',
        stageHired: 'Kazanıldı',
        moreTitle: 'Ve çok daha fazlası',
        moreSubtitle: 'Kutudan çıkan diğer şeylerden kısa bir örnek.',
        more1: 'Müşteri adayını elle ekleyin ya da CSV ile içe, Excel ile dışa aktarın',
        more2: 'Kayıtlı görünümler, filtreler ve hızlı sunucu taraflı sayfalama',
        more3: 'Aday ve firmaları istediğiniz gibi dilimlemek için etiketler',
        more4: 'OpenAPI şemalı salt-okunur REST API, API anahtarları ve imzalı webhook’lar',
        more5: 'ICS beslemeli takvim, uygunluk aralıkları ve toplantı talepleri',
        more6: 'Adaylarda yinelenen tespiti ve tek tıkla birleştirme',
        more7: 'Ekibiniz için davet yaşam döngüsü takibi (gönderildi → açıldı → kaydoldu → doğrulandı)',
        more8: 'Erişilebilirlik: ayarlanabilir yazı boyutu, atlama bağlantıları ve görünür odak halkaları',
        ctaTitle: 'Her anlaşmayı tek yerde görmeye hazır mısınız?',
        ctaSubtitle: 'Hattınızı dakikalar içinde kurun — ekibiniz davetle giriş yapar.',
        ctaMentee: 'Giriş yap',
        ctaFootnote: 'Açık kaynak, AGPL-3.0 — kod GitHub’da.',
        trans5T: 'Mekanizma olarak onay',
        trans5D: 'Müşteri verisi ekibiniz dışında kimseye gösterilmez; her onay sürümüyle kaydedilir ve her an geri alınabilir. E-posta ve telefon hiçbir herkese açık sayfada görünmez.',
        transBeta: 'Ve dürüst kısmı: pazarlama ürünü erken erişimde, küçük bir ekip yazıyor, henüz müşteri referansı yok. Bunu sonradan öğrenmenizden burada okumanızı tercih ederiz.',
        founderBody: 'SaleVali, yüzlerce kişiye mentorluk platformu çalıştıran aynı çekirdek üzerinde, {name} tarafından — tek kişi, açıkta — geliştiriliyor ve bakımı yapılıyor. Soru ve eleştiriye açığız.',
        badge: 'Pazarlama CRM · Adayları takip et · Anlaşmaları kapat',
        heroTitle: 'Her aday, her görüşme, her anlaşma —',
        heroAccent: 'tek bir hatta.',
        heroSubtitle: 'Müşterilerini ilk temastan kapanışa kadar takip et. Her anlaşmanın nerede olduğunu, en son kimin dokunduğunu ve sıradaki adımı — tabloda parça parça aramak yerine — tek bakışta gör.',
        featuresTitle: 'Kapatmak için ekibinin ihtiyacı olan her şey',
        featuresSubtitle: 'Müşterileri takip etmek ve anlaşmaları ilerletmek için tasarlandı.',
      },
      featureCatalog: {
        title: 'SaleVali neler yapabilir',
        subtitle: 'Tüm özellik kataloğu — ilk temastan kapanan anlaşmaya, tüm ekibiniz için.',
        categories: { collaboration: 'Birlikte çalışma' },
        items: {
          messaging: { d: 'Fırsat başına thread’ler, ekler ve cevaplanabilir e-posta yansıtması olan tek gelen kutusu — bildirimi kendi e-posta uygulamanızdan yanıtlayın, cevabınız thread’e düşer. Mesajlar gelen kutusu açıkken anında görünür; izin verirseniz uygulama kapalıyken de cihazınıza bildirim gelir. Yarım kalan yanıt gönderilene kadar sohbet başına saklanır ve karşı taraf yazarken bunu görürsünüz. Sürekli verdiğiniz yanıtlar ortak bir hazır yanıt havuzunda durur — İngilizce, Türkçe ve Almanca bir kez yazılır, kendi dilinizde tek tıkla eklenir.' },
          videoCalls: { d: 'Bir müşteri adayı, firma ekibi veya sohbetle tek tıkla görüşme başlat; görüşme, kaydın yanındaki yan panelde kendi Jitsi kiracımızda açılır — hesap yok, kurulum yok, süre sınırı yok. Görüşme ücretsiz herkese açık odaya düşmek zorunda kalırsa panel bunu kimse katılmadan önce söyler ve konuşmayı sürdürmenin tek tıklık yolunu verir. Link davet edilen herkese e-postayla gider ve her tarayıcıda çalışır.' },
          externalGuests: { d: 'Bir toplantı her zaman yalnızca kendi ekibinizden ibaret değildir. Planlayıcıya herhangi bir e-posta adresi yaz; o kişi aynı odaya, aynı Evet/Hayır butonlarıyla davet edilsin — hesap yok, kayıt yok, kendi takvimi için .ics var. Kimin kabul ettiğini görürsün ve yanlış adrese giden bir davet geri alınabilir; bağlantısı da o anda çalışmayı bırakır.' },
          ownWorkspace: { t: 'Her satış temsilcisine kendi çalışma alanı', d: 'Her temsilci kendi portföyüne giriş yapar: müşteri adayları ve hesapları, vadesi gelen takipler ve deneme bitişleri, kendi panosu — ve az önce yaptığı görüşmeyi hemen kaydetme imkânı. Başka bir temsilcinin ya da başka bir kuruluşun fırsatları gizli bir sekmede durmaz; o sayfada hiç yoktur.' },
          inviteLinks: { d: 'Adresini bilmediğin birini davet et: alanı boş bırak, elden verebileceğin tek kullanımlık ve 7 gün geçerli bir bağlantı üretilsin. Bağlantıyla kaydolan kişi doğrudan gönderene bağlanır ve özel bir not, birbirine benzeyen bağlantıları ayırt edilebilir kılar.' },
        },
      },
      pricing: {
        heroBadge: 'Pazarlama fiyatlandırması henüz yayınlanmadı',
        heroTitle: 'Fiyat hakkında bugün söyleyebileceklerimiz',
        heroSubtitle: 'Pazarlama ürününün paketlemesi henüz belirlenmedi; bu yüzden bu sayfada fiyat listesi yok — geri almak zorunda kalacağımız bir rakam göstermektense hiçbir şey göstermemeyi tercih ederiz. Paketleme ne olursa olsun bugün de doğru olanlar aşağıda.',
        discountsTitle: 'Şimdiden doğru olanlar',
      },
      bulkInvite: { roleMentee: 'Müşteri adayı', roleMentor: 'Satış temsilcisi' },
      assignMentor: {
        label: 'Temsilci ata',
        chooseMentor: 'Bir temsilci seç…',
        alreadyAssigned: 'Bu müşteri adayının zaten bir temsilcisi var.',
        suggestHint: 'En uygun temsilciyi öner (mümkünse yapay zekâ destekli)',
        noSuggestion: 'Önerilecek uygun temsilci yok.',
        confirmAtCapacity: 'Bu temsilcinin kapasitesi dolmuş görünüyor. Yine de atansın mı?',
        confirmNotAccepting: 'Bu temsilci yeni müşteri adayı almadığını belirtti. Yine de atansın mı?',
      },
      roleChangeEmail: {
        subjectMentor: 'Hesabın artık bir satış temsilcisi hesabı',
        subjectMentee: 'Hesabın artık bir müşteri adayı hesabı',
        headingMentor: 'Artık satış temsilcisisin',
        headingMentee: 'Hesabın artık bir müşteri adayı hesabı',
        bodyMentor: 'Bir yönetici hesabını satış temsilcisi hesabına dönüştürdü. Tüm cihazlardan çıkış yapıldı; tekrar giriş yaptığında satış çalışma alanına ineceksin. Mevcut fırsatların ve geçmişin aynen duruyor.',
        bodyMentee: 'Bir yönetici hesabını müşteri adayı hesabına dönüştürdü. Tüm cihazlardan çıkış yapıldı; tekrar giriş yaptığında hesap sayfana ineceksin. Mevcut fırsatların ve geçmişin aynen duruyor.',
      },
      evaluationFramework: {
        subtitle: 'Bir fırsatın neye göre puanlandığı. Dokunmazsan yerleşik kriterler geçerli kalır; kendi kriterlerini tanımlarsan değerlendirmelerin yazıldığı ve okunduğu her yerde onların yerini alır.',
        onMentee: 'Temsilcinin müşteri adayını puanladığı kriterler',
        onMentor: 'Müşteri adayının temsilciyi puanladığı kriterler',
      },
      stageSla: {
        subtitle: 'Bir aşamada en fazla ne kadar beklenebileceği; aşıldığında temsilciye uyarı gider. Boş bıraktığın aşamanın kuralı yoktur — hiç kural tanımlamayan bir kurum eskisi gibi çalışmaya devam eder.',
      },
    },
    de: {
      nav: { candidates: 'Leads', companyInquiries: 'Demo-Anfragen', myCompanies: 'Meine Accounts' },
      invite: {
        subtitle: 'Vertriebsmitarbeiter und Leads einladen',
        connectMentor: 'Diesem Vertriebsmitarbeiter zuordnen (optional)',
        connectMentee: 'Diesen Lead dem neuen Vertriebsmitarbeiter geben (optional)',
        connectHint: 'Hier gewählt, wird der Lead bei der Registrierung sofort zugeordnet — kein weiterer Schritt.',
        mentorTitle: 'Lead einladen',
        mentorAutoAssign: 'Wer sich über deinen Link registriert, wird automatisch dein Lead — kein Zuweisungsschritt. Der Link gilt einmalig und verfällt nach 7 Tagen.',
      },
      notifications: {
        invitationEmail: {
          roles: { MENTOR: 'Vertriebsmitarbeiter', MENTEE: 'Lead' },
        },
        events: {
          'interaction.logged': 'Ein neuer Interaktionseintrag wurde hinzugefügt.',
          'company_interest.mentee': 'Ein Unternehmen hat Interesse an deinem Profil gezeigt. Deine Ansprechperson meldet sich bei dir.',
          'mentorship_request.mentorAssigned': 'Dir wurde eine Ansprechperson zugewiesen: {mentorName}.',
          'mentorship_request.menteeAssigned': 'Dir wurde ein neuer Lead zugewiesen: {menteeName}.',
          'mentorship.mentorChanged': 'Deine Ansprechperson hat sich geändert — {mentorName} betreut dich jetzt.',
          'mentorship.reassignedAway': '{menteeName} wurde an einen anderen Vertriebsmitarbeiter übergeben — dein Deal mit der Person ist beendet.',
          'mentorship.assignmentCorrected': '{menteeName} wurde dir versehentlich zugewiesen und ist nicht mehr dein Lead.',
          'mentorship.bulkAssigned': 'Neu zugewiesene Leads: {count}.',
          'mentorship.bulkReassignedAway': 'An einen anderen Vertriebsmitarbeiter übergebene Deals: {count}.',
          'mentorship.autoLinkSkipped': '{name} hat sich über eine Einladung registriert, aber der vorverknüpfte Lead hat bereits einen Vertriebsmitarbeiter — es wurde kein Deal angelegt.',
          'role_changed.toMentor': 'Ein Administrator hat dein Konto in ein Vertriebskonto umgewandelt.',
          'role_changed.toMentee': 'Ein Administrator hat dein Konto in ein Lead-Konto umgewandelt.',
        },
        menteeAssignedEmail: {
          subject: 'Neuer Lead zugewiesen: {mentee}',
          heading: 'Du hast einen neuen Lead',
          body: '{mentee} wurde dir als Lead zugewiesen. Melde dich, um eine Demo zu vereinbaren, und erfasse dabei deine erste Interaktion.',
          cta: 'Vertriebs-Dashboard öffnen',
        },
        // Geht an einen Kunden: Sie-Form.
        mentorAssignedEmail: {
          subject: 'Ihre Ansprechperson: {mentor}',
          heading: 'Sie haben eine persönliche Ansprechperson',
          body: '{mentor} ist ab jetzt Ihre persönliche Ansprechperson. Schreiben Sie jederzeit — zu einer Demo, Ihrer Testphase oder zur Anbindung Ihrer Marktplätze.',
          cta: 'Nachrichten öffnen',
        },
        mentorDigestEmail: {
          subject: 'Deine wöchentliche Vertriebsübersicht',
          stale: '{n} Lead(s) ohne Kontakt seit 14+ Tagen',
          newApplications: '{n} neue(r) Lead(s) in den letzten 7 Tagen',
        },
        activityDigestEmail: {
          subject: 'Tägliche Lead-Aktivität',
          subjectAll: 'Tägliche Lead-Aktivität (alle Leads)',
          heading: 'Tägliche Lead-Aktivität',
          greetingMentor: 'Hallo {name}, das haben deine Leads in den letzten 24 Stunden gemacht:',
          greetingAdmin: 'Hallo {name}, systemweite Lead-Aktivität der letzten 24 Stunden:',
          trackingNote: 'Verweildauer und Seitenaufrufe werden nur für Leads angezeigt, die das Aktivitäts-Tracking aktiviert haben.',
          columns: { mentee: 'Lead' },
        },
      },
      usersAdmin: {
        mentor: 'Vertriebsmitarbeiter',
        mentee: 'Lead',
        makeMentor: 'Zum Vertriebsmitarbeiter machen',
        makeMentee: 'Zum Lead machen',
        convertToMentorConfirm: '{name} wird auf allen Geräten abgemeldet und ist bei der nächsten Anmeldung Vertriebsmitarbeiter. Bestehende Datensätze bleiben erhalten.',
        convertToMenteeConfirm: '{name} wird auf allen Geräten abgemeldet und ist bei der nächsten Anmeldung ein Lead. Bestehende Datensätze bleiben erhalten.',
        stateNoLoginHint: 'Ein von einem Vertriebsmitarbeiter oder Import angelegter Datensatz. Ohne Passwort kann sich niemand damit anmelden.',
      },
      candidateDetail: {
        mentorship: 'Zuständig',
        notAssigned: 'Diesem Lead ist noch kein Vertriebsmitarbeiter zugeordnet',
        mentor: 'Vertriebsmitarbeiter',
      },
      messages: {
        openers: {
          welcome: {
            label: '👋 Willkommen',
            text: 'Hallo {name}, danke für Ihr Interesse an SaleVali! Ich bin ab jetzt Ihr Ansprechpartner — schreiben Sie mir in diesem Chat, wann immer etwas ist.',
          },
          introCall: {
            label: 'Demo vereinbaren',
            text: 'Hallo {name}, sollen wir eine kurze Demo machen? Welche Tage und Zeiten passen Ihnen diese Woche?',
          },
          goals: {
            label: 'Nach dem Bedarf fragen',
            text: 'Hallo {name}, vor der Demo würde ich gern hören, auf welchen Marktplätzen Sie verkaufen und was Sie sich von der Testphase erwarten.',
          },
          intro: {
            label: 'Unseren Shop vorstellen',
            text: 'Hallo {name}, ich stelle unseren Shop kurz vor: ',
          },
        },
        listSubtitle: 'Deine Unterhaltungen',
      },
      forCompanies: {
        submit: 'Demo anfragen',
        successBody: 'Ihre Anfrage hat unser Vertriebsteam erreicht. Wir melden uns innerhalb von zwei Werktagen, um einen Termin für die Demo zu finden.',
      },
      companyInquiriesAdmin: {
        title: 'Demo-Anfragen',
        subtitle: 'Anfragen aus dem Demo-Formular Ihrer Website. Mit Standard-Zuständigkeit ist eine Anfrage schon in der Pipeline; die übrigen warten hier ohne Zuständige, bis ein Admin sie übernimmt.',
        emptyTitle: 'Keine Anfragen offen',
        emptyBody: 'Demo-Anfragen von Ihrer Website landen hier, und alle Admins werden bei Eingang per E-Mail benachrichtigt.',
      },
      candidates: {
        title: 'Leads',
        subtitle: 'Leads durchsuchen',
        mentor: 'Vertriebsmitarbeiter',
        mineFilter: 'Meine Kunden',
        bulkOwnerLabel: 'Vertriebsmitarbeiter',
        bulkAssignOwner: 'Vertriebsmitarbeiter zuweisen',
      },
      publicNav: {
        homeLink: 'SaleVali — zur Startseite',
        tagline: 'Leads, Accounts und Deals in einer Pipeline — vom ersten Kontakt bis zum Abschluss.',
      },
      auth: {
        signinSubtitle: 'Melden Sie sich bei Ihrem SaleVali-Konto an',
        registerSubtitle: 'Mit Ihrer Einladung registrieren',
        tokenHint: 'Fügen Sie den Einladungscode aus Ihrer E-Mail ein. Konten in diesem Produkt werden per Einladung angelegt.',
      },
      dashboard: {
        subtitle: 'Überblick über Ihre Marketing-Pipeline',
        mentees: 'Leads',
        mentors: 'Vertriebsmitarbeiter',
        activeMentorships: 'Aktive Deals',
        perStage: 'Leads pro Phase',
        recentMentorships: 'Aktuelle Deals',
        latestAssignments: 'Neueste Deals',
        noMentorships: 'Noch keine Deals',
        newCandidates: 'Neue Leads',
        recentlyRegistered: 'Kürzlich hinzugefügte Leads',
        noCandidates: 'Noch keine Leads',
        quickActions: { browseCandidates: 'Leads durchsuchen' },
      },
      checklist: {
        steps: {
          inviteMentors: 'Laden Sie Ihre ersten Mitarbeiter ein',
          inviteMentees: 'Fügen Sie Ihre ersten Leads hinzu',
          assignMentorship: 'Ersten Deal anlegen',
        },
      },
      emailGroups: {
        direct_messages: { desc: 'Ein echter Mensch hat dir geschrieben: eine Nachricht in der App oder die direkte E-Mail einer Kollegin oder eines Kollegen.' },
        mentorship_lifecycle: { name: 'Lead-Meilensteine', desc: 'Bei einem deiner Leads hat sich etwas geändert — Anfragen, Entscheidungen und Zuordnungen.' },
        digests: { desc: 'Regelmäßige Sammelmails: ungelesene Nachrichten, Tagesaktivität, die wöchentliche Vertriebsübersicht.' },
        inbound_requests: { desc: 'Jemand möchte etwas von dir: ein Kontaktformular, eine Demo-Anfrage, eine Beitrittsanfrage.' },
      },
      account: {
        notifCategories: { mentorship: 'Lead-Updates' },
        expertiseHint: 'Einer pro Zeile oder kommagetrennt — damit dir passende Leads zugewiesen werden',
        capacity: 'Lead-Kapazität',
        capacityHint: 'Maximale Leads gleichzeitig (leer = kein Limit)',
        activeMentees: '{count} / {capacity} aktive Leads',
        acceptingMentees: 'Ich kann einen neuen Lead übernehmen',
      },
      consent: {
        items: {
          activityTracking: {
            desc: 'Erlaube die Aufzeichnung, welche Seiten du besuchst und wie lange, damit deine Admins einen detaillierten Aktivitätsbericht sehen. Standardmäßig aus; aufgezeichnet wird nur die Navigation in der App — nie Tastatureingaben oder Seiteninhalte.',
          },
          mentorDirectoryVisibility: {
            title: 'Eintrag im Ansprechpersonen-Verzeichnis',
            desc: 'Mein Profil im Verzeichnis der Ansprechpersonen anzeigen. Sichtbar: Name, Fachgebiete, Sprachen, Kapazitätsstatus und Kurzprofil — niemals E-Mail, Telefon oder deine Lead-Liste. Jederzeit widerrufbar; die Karte verschwindet sofort.',
          },
          aiInteractionSummary: { desc: 'Erlaube deiner Ansprechperson, eine KI-Zusammenfassung des Interaktionsprotokolls zu deinem Deal zu erstellen. Nur der Protokolltext wird an den KI-Anbieter gesendet — nie Dateien oder Kontaktdaten. Standardmäßig aus.' },
        },
      },
      settings: {
        reminderDaysHint: 'Einen Vertriebsmitarbeiter nach so vielen Tagen ohne erfasste Interaktion erinnern',
        weeklyDigest: 'Wöchentliche Zusammenfassung für Vertriebsmitarbeiter senden',
        outcomeAutoSendHint: 'Standardmäßig aus. Aus: Beim Erreichen einer Ergebnisphase wird der Vertriebsmitarbeiter benachrichtigt und erhält einen Entwurf zum Lesen, Bearbeiten und Senden. An: Die Vorlage geht ohne Prüfung an den Lead — eine Absage lässt sich nicht zurückholen.',
        require2faAdminsMentors: 'Pflicht für Admins und Vertriebsmitarbeiter',
        aiMonthlyQuotaHint: 'Wie viele Aufrufe an den KI-Anbieter pro Kalendermonat erlaubt sind. Alle KI-Funktionen nutzen dasselbe Kontingent; gezählt wird nur ein erfolgreicher Aufruf, und der Zähler wird am 1. zurückgesetzt. Die Nutzung wird für die gesamte Installation gemessen, nicht pro Organisation — auf einer geteilten Installation verbraucht jede Organisation aus demselben Monatskontingent. Ist es aufgebraucht, lehnt die KI-Schranke weitere Aufrufe bis zum nächsten Monat ab; der Rest der App ist nicht betroffen. 0 schaltet KI komplett ab.',
        // The import card (#2552 review): the second mode is the legacy people
        // importer, shown next to the account import; it creates MENTEE rows — a
        // MARKETING org's leads — so the card says people.
        bulkImport: 'Personen im Stapel importieren',
        importModeMentees: 'Personen (Leads)',
      },
      analytics: {
        subtitle: 'Funnel, Auslastung der Vertriebsmitarbeiter und Aktivitäts-Insights',
        cohortTotal: 'Leads',
        cohortHired: 'Gewonnen',
        sourceConversionTitle: 'Konversion nach Quelle',
        sourceConversionEmpty: 'Noch keine Quellen — weise Leads eine Quelle zu, um die Konversion pro Quelle zu sehen.',
        sourceUnsourced: '{n} Lead(s) ohne Quelle werden oben nicht angezeigt.',
        aging: {
          dropReasonsTitle: 'Verlustgründe',
          dropReasonsEmpty: 'Noch keine verlorenen Deals erfasst.',
        },
        funnelKpi: {
          capacity: 'Vertriebskapazität',
          capacityHint: 'Aktive Leads gegen die Obergrenze, die jeder Vertriebsmitarbeiter selbst gesetzt hat. Der Status kommt aus derselben Regel wie im Zuweisungsdialog.',
          mentor: 'Vertriebsmitarbeiter',
        },
        mentorWorkload: 'Vertriebsauslastung & Ergebnisse',
        interns: 'Mitglieder',
        trendNewRelations: 'Neue Deals',
        cohortInteractions: 'Interaktionen / Lead',
      },
      dropoff: {
        dialogHint: 'Diese Phase liegt außerhalb des normalen Ablaufs — ein Grund hält die Verlust-Auswertung aussagekräftig.',
      },
      companyDetail: {
        sections: { funnel: 'Deals', needs: 'Offener Bedarf' },
        funnel: {
          person: 'Lead',
          owner: 'Vertriebsmitarbeiter',
          empty: 'Für diesen Account gibt es noch keine Deals.',
          continues: 'Setzt einen früheren Deal von {name} fort',
        },
        needsEmpty: 'Kein Bedarf erfasst.',
        // The external id is what the usage feed keys on (#2560) — a MARKETING-only notion.
        externalId: { hint: 'Die ID dieses Accounts in dem Produkt, das Sie verkaufen. Nutzungsdaten finden den Account darüber, daher muss sie in Ihrer Organisation eindeutig sein.' },
      },
      companiesPage: {
        subtitle: 'Kunden-Accounts und ihren Bedarf verwalten',
        addLoginHint: 'Erstelle einen Zugang mit Lesezugriff, damit ein Unternehmen seine verknüpften Leads einsehen kann.',
        mentorships: 'Deals',
        positions: 'Bedarfe',
        openPositions: 'Offener Bedarf',
        deleteDialog: {
          labels: { needs: 'offene Bedarfe', interests: 'Lead-Interessen', mentorships: 'Deals' },
        },
      },
      companyForm: {
        quota: 'Bedarfskontingent',
        needs: 'Bedarf des Accounts',
        noNeeds: 'Noch kein Bedarf hinzugefügt. Klicke auf "Bedarf hinzufügen", um festzuhalten, was dieser Account braucht.',
      },
      entitlements: {
        subtitle: 'Premium-Funktionen für {name} aktivieren. Funktionen für Vertriebsmitarbeiter und Leads sind immer kostenlos.',
      },
      board: { emptyStage: 'Keine Leads in dieser Phase' },
      adminBoard: {
        subtitle: 'Alle Leads aller Vertriebsmitarbeiter — ziehe eine Karte oder nutze ihr Phasenmenü, um die Phase zu ändern',
        searchPlaceholder: 'Lead oder Vertriebsmitarbeiter finden...',
        wipSaturated: 'Jede Spalte dieses Boards liegt über ihrem Arbeitslimit, damit zeigt die bernsteinfarbene Warnung nirgendwo mehr hin und wird ausgeblendet. Lege ein Limit fest, das zu dieser Pipeline passt — eine Zahl für das ganze Board oder eine je Phase.',
        groups: { pre: 'Leads', internship: 'Deals', custom: 'Funnel' },
      },
      personCard: { roleMentor: 'Vertriebsmitarbeiter', roleMentee: 'Lead' },
      panel: { sales: 'Vertrieb' },
      sales: {
        dashboard: { title: 'Deine Vertriebs-Pipeline', subtitle: 'Deine eigenen Leads und Accounts und was heute ansteht.' },
        stats: { open: 'Offene Leads', accounts: 'Accounts' },
        records: {
          title: 'Meine Leads',
          empty: 'Dir ist noch kein Lead zugewiesen. Ein Admin — oder die Einstellung für den Standard-Owner — weist sie dir zu.',
          person: 'Lead',
          company: 'Account',
        },
        accounts: {
          title: 'Meine Accounts',
          subtitle: 'Die Accounts hinter deinen eigenen Leads.',
          empty: 'Noch keiner deiner Leads ist mit einem Account verknüpft.',
          name: 'Account',
          records: 'Deine Leads',
          back: 'Meine Accounts',
        },
        lead: { back: 'Meine Leads', company: 'Account' },
      },
      mentor: {
        boardSubtitle: 'Deine Leads nach Phase — ziehe eine Karte oder nutze ihr Phasenmenü, um sie zu verschieben',
        menteeBoardSearchPlaceholder: 'Lead suchen...',
        noMatchingMentees: 'Keine Leads passen zu diesem Filter',
      },
      emptyStates: {
        board: {
          adminBody: 'Jeder Deal erscheint hier als Karte, in der Phase, die er erreicht hat. Lege die ersten Leads an — sobald ein Vertriebsmitarbeiter sie übernimmt, taucht ihre Karte auf.',
          mentorBody: 'Deine Leads erscheinen hier als Karten, sobald sie dir zugewiesen sind.',
        },
        companies: {
          adminBody: 'Unternehmen sind die Accounts, an die du verkaufst: sobald eines existiert, kannst du ihm seinen Bedarf, Ansprechpersonen und die offenen Deals zuordnen.',
        },
      },
      landing: {
        chipStages: 'Eine Pipeline vom Lead bis zum Abschluss',
        chipRoles: 'Open Source — AGPL-3.0',
        chipLangs: 'English · Türkçe · Deutsch',
        chipGdpr: 'Ihre Kundendaten bleiben Ihre',
        fPipelineT: 'Pipeline-Tracking',
        fPipelineD: 'Jeder Lead auf einem Board, von neu bis gewonnen oder verloren — Drag-and-drop-Phasen, eine Frist pro Phase mit Überfälligkeitsmarkern und eine vollständige Historie, wer was wann verschoben hat.',
        fCompanyT: 'Accounts & Kontakte',
        fCompanyD: 'Verfolgen Sie die Unternehmen, an die Sie verkaufen, und die Menschen darin — legen Sie einen neuen Account samt Lead in einem Schritt an, halten Sie den Bedarf jedes Accounts fest und sehen Sie jeden offenen Deal an einem Ort.',
        fCommsT: 'Kommunikation',
        fCommsD: 'Meeting-Einladungen mit RSVP, In-App-Nachrichten zu jedem Deal, Einzel- und Massen-E-Mails, Ankündigungen, Benachrichtigungseinstellungen pro Kategorie, Erinnerungen und ein Wochen-Digest.',
        fDocsT: 'Dokumente & Vorlagen',
        fDocsD: 'Versionierte Uploads zu jedem Lead oder Account, eine mehrsprachige Vorlagenbibliothek für Angebote und Nachfassen mit In-App-Vorschau und PDF-Export.',
        fAnalyticsT: 'Analytics & Einblicke',
        fAnalyticsD: 'Conversion-Funnel, Dauer und Alterung pro Phase, Deals pro Mitarbeiter und deren Ergebnisse, Sechsmonatstrends mit Zeitraumauswahl.',
        fPrivacyT: 'Zugriff & Datenschutz',
        fPrivacyD: 'Rollenbasierter Zugriff, Zwei-Faktor-Authentifizierung, E-Mail-Verifizierung, Aktivitätsprotokoll und ein vollständiges DSGVO-Toolkit: Einwilligung, Aufbewahrungserinnerungen, Löschung und Datenexport per Klick.',
        fPlatformT: 'Ein angenehmer Arbeitsplatz',
        fPlatformD: 'Drei Sprachen (EN/TR/DE), Dark Mode, anpassbare Schriftgröße, globale Suche, installierbar als App (PWA) mit Offline-Unterstützung und eine öffentliche „Neuigkeiten“-Seite.',
        pipelineTitle: 'Vom ersten Kontakt zum Abschluss',
        pipelineSubtitle: 'Jeder Lead durchläuft dieselben Phasen — Sie wissen immer, wo ein Deal steht und was der nächste Schritt ist.',
        pipelineStagesNote: 'Unter der Haube: sieben granulare Phasen — von neuer Lead bis gewonnen oder verloren — mit Service-Level pro Phase und Überfälligkeitsmarkern.',
        pipelineNote: 'Nicht jeder Lead schließt ab: Verlorene Deals werden ebenfalls erfasst, damit der Funnel die Wahrheit sagt.',
        stageApply: 'Neuer Lead',
        stageInterview: 'Kontaktiert',
        stageInternship: 'Angebot gesendet',
        stageHired: 'Gewonnen',
        moreTitle: 'Und noch viel mehr',
        moreSubtitle: 'Eine kleine Auswahl dessen, was sonst noch mitgeliefert wird.',
        more1: 'Leads von Hand anlegen, per CSV importieren und nach Excel exportieren',
        more2: 'Gespeicherte Ansichten, Filter und schnelle serverseitige Paginierung',
        more3: 'Tags, um Leads und Accounts beliebig zu gliedern',
        more4: 'Schreibgeschützte REST-API mit OpenAPI-Spezifikation, API-Schlüsseln und signierten Webhooks',
        more5: 'Kalender mit ICS-Feed, Verfügbarkeitsfenstern und Meeting-Anfragen',
        more6: 'Duplikaterkennung und Zusammenführen per Klick für Leads',
        more7: 'Einladungs-Lebenszyklus für Ihr Team (gesendet → geöffnet → registriert → verifiziert)',
        more8: 'Barrierefreiheit: anpassbare Schriftgröße, Sprunglinks und sichtbare Fokusringe',
        ctaTitle: 'Bereit, jeden Deal an einem Ort zu sehen?',
        ctaSubtitle: 'Richten Sie Ihre Pipeline in Minuten ein — Ihr Team meldet sich per Einladung an.',
        ctaMentee: 'Anmelden',
        ctaFootnote: 'Open Source, AGPL-3.0 — der Code ist auf GitHub.',
        trans5T: 'Einwilligung als Mechanismus',
        trans5D: 'Kundendaten sieht niemand außerhalb Ihres Teams; jede Einwilligung wird mit Version erfasst und ist jederzeit widerrufbar. E-Mail und Telefon erscheinen auf keiner öffentlichen Seite.',
        transBeta: 'Und der ehrliche Teil: Das Marketing-Produkt ist im Early Access, von einem kleinen Team gebaut, noch ohne Kundenstimmen. Wir möchten, dass Sie das hier lesen und nicht später erfahren.',
        founderBody: 'SaleVali wird von {name} gebaut und gepflegt — eine Person, offen, auf demselben Kern, der eine Mentoring-Plattform für Hunderte betreibt. Fragen und Kritik sind willkommen.',
        badge: 'Marketing-CRM · Leads verfolgen · Abschlüsse erzielen',
        heroTitle: 'Jeder Lead, jedes Gespräch, jeder Abschluss —',
        heroAccent: 'in einer Pipeline.',
        heroSubtitle: 'Verfolgen Sie Ihre Kunden vom ersten Kontakt bis zum Abschluss. Sehen Sie auf einen Blick, wo jeder Deal steht, wer ihn zuletzt bearbeitet hat und was als Nächstes zu tun ist — statt es aus einer Tabelle zusammenzusuchen.',
        featuresTitle: 'Alles, was Ihr Team zum Abschluss braucht',
        featuresSubtitle: 'Entwickelt, um Kunden zu verfolgen und Deals voranzutreiben.',
      },
      featureCatalog: {
        title: 'Alles, was SaleVali kann',
        subtitle: 'Der vollständige Funktionskatalog — vom Erstkontakt bis zum Abschluss, für Ihr ganzes Team.',
        categories: { collaboration: 'Zusammenarbeit' },
        items: {
          messaging: { d: 'Ein zentraler Posteingang mit einem Thread pro Deal, Anhängen und beantwortbarer E-Mail-Spiegelung — antworte aus deinem Mailprogramm, und die Antwort landet im Thread. Nachrichten erscheinen live, solange der Posteingang offen ist, und können dein Gerät auch bei geschlossener App benachrichtigen. Eine halb geschriebene Antwort bleibt pro Gespräch erhalten, bis du sie sendest, und du siehst, wenn die andere Person schreibt. Antworten, die du immer wieder gibst, liegen in einem gemeinsamen Pool vorgefertigter Antworten — einmal auf Englisch, Türkisch und Deutsch verfasst, mit einem Klick in deiner eigenen Sprache eingefügt.' },
          videoCalls: { d: 'Starte mit einem Klick einen Anruf mit einem Lead, einem Account-Team oder einem Chat — er läuft in einem Seitenpanel neben dem Datensatz auf unserem eigenen Jitsi-Tenant: kein Konto, keine Installation, kein Zeitlimit. Muss ein Anruf auf den freien öffentlichen Raum ausweichen, sagt das Panel das, bevor jemand beitritt, samt Ein-Klick-Weg zum Weiterreden. Der Link geht per E-Mail an alle Eingeladenen und funktioniert in jedem Browser.' },
          externalGuests: { d: 'Ein Meeting besteht nicht immer nur aus dem eigenen Team. Tippe eine beliebige E-Mail-Adresse in die Planung, und diese Person ist im selben Raum eingeladen — mit denselben Ja/Nein-Buttons, ohne Konto, ohne Registrierung und mit .ics für den eigenen Kalender. Du siehst, wer zugesagt hat, und eine an die falsche Adresse gegangene Einladung lässt sich zurückziehen; ihr Link funktioniert dann nicht mehr.' },
          ownWorkspace: { t: 'Ein Arbeitsbereich für jeden Vertriebsmitarbeiter', d: 'Jeder Vertriebsmitarbeiter meldet sich in seinem eigenen Bestand an: seine Leads und Accounts, fällige Wiedervorlagen und Testphasen-Enden, sein eigenes Board — und das Gespräch, das er gerade geführt hat, gleich erfassen. Die Deals eines Kollegen oder einer anderen Organisation liegen nicht einen versteckten Reiter entfernt; auf dieser Seite gibt es sie schlicht nicht.' },
          inviteLinks: { d: 'Lade jemanden ein, dessen Adresse du nicht kennst: Feld leer lassen, und es entsteht ein einmalig gültiger 7-Tage-Link zum persönlichen Übergeben. Wer sich damit registriert, ist sofort mit der einladenden Person verbunden — und eine private Notiz hält eine Wand aus Links unterscheidbar.' },
        },
      },
      pricing: {
        heroBadge: 'Die Marketing-Preise sind noch nicht veröffentlicht',
        heroTitle: 'Was wir heute über den Preis sagen können',
        heroSubtitle: 'Die Paketierung des Marketing-Produkts steht noch nicht fest, deshalb gibt es auf dieser Seite keine Preisliste — lieber zeigen wir nichts als eine Zahl, die wir zurücknehmen müssten. Was unabhängig von der Paketierung schon heute gilt, steht unten.',
        discountsTitle: 'Was schon heute gilt',
      },
      bulkInvite: { roleMentee: 'Lead', roleMentor: 'Vertriebsmitarbeiter' },
      assignMentor: {
        label: 'Vertriebsmitarbeiter zuweisen',
        chooseMentor: 'Vertriebsmitarbeiter wählen…',
        alreadyAssigned: 'Dieser Lead hat bereits einen Vertriebsmitarbeiter.',
        suggestHint: 'Den passendsten Vertriebsmitarbeiter vorschlagen (KI-gestützt, wenn verfügbar)',
        noSuggestion: 'Kein verfügbarer Vertriebsmitarbeiter zum Vorschlagen.',
        confirmAtCapacity: 'Dieser Vertriebsmitarbeiter scheint ausgelastet zu sein. Trotzdem zuweisen?',
        confirmNotAccepting: 'Dieser Vertriebsmitarbeiter nimmt laut eigener Angabe keine neuen Leads an. Trotzdem zuweisen?',
      },
      roleChangeEmail: {
        subjectMentor: 'Dein Konto ist jetzt ein Vertriebskonto',
        subjectMentee: 'Dein Konto ist jetzt ein Lead-Konto',
        headingMentor: 'Du bist jetzt im Vertrieb',
        headingMentee: 'Dein Konto ist jetzt ein Lead-Konto',
        bodyMentor: 'Ein Administrator hat dein Konto in ein Vertriebskonto umgewandelt. Du wurdest auf allen Geräten abgemeldet; bei der nächsten Anmeldung landest du in deinem Vertriebsbereich. Deine bestehenden Deals und dein Verlauf bleiben unberührt.',
        bodyMentee: 'Ein Administrator hat dein Konto in ein Lead-Konto umgewandelt. Du wurdest auf allen Geräten abgemeldet; bei der nächsten Anmeldung landest du auf deiner Kontoseite. Deine bestehenden Deals und dein Verlauf bleiben unberührt.',
      },
      evaluationFramework: {
        subtitle: 'Wonach ein Deal bewertet wird. Rührst du nichts an, bleiben die eingebauten Kriterien in Kraft; definierst du eigene, ersetzen sie diese überall, wo Bewertungen geschrieben und gelesen werden.',
        onMentee: 'Wonach ein Vertriebsmitarbeiter einen Lead bewertet',
        onMentor: 'Wonach ein Lead einen Vertriebsmitarbeiter bewertet',
      },
      stageSla: {
        subtitle: 'Wie lange jemand in einer Phase warten darf, bevor der zuständige Vertriebsmitarbeiter gewarnt wird. Eine leer gelassene Phase hat keine Regel — eine Organisation ohne Regeln arbeitet genau wie bisher weiter.',
      },
    },
  },
};

// Is there anything to merge for this vertical+locale? Lets the caller skip the
// merge (and return the base object unchanged) for the common empty case.
function hasOverlay(vertical: VerticalKey, locale: Locale): boolean {
  return Object.keys(OVERLAYS[vertical]?.[locale] ?? {}).length > 0;
}

// Deep-merge an overlay onto a base dictionary, returning a NEW object; the base
// is never mutated (it is shared module state for the process). Only plain
// objects recurse; every leaf (string, array, number) is replaced wholesale.
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, overlay: DeepPartial<T>): T {
  if (!isPlainObject(base) || !isPlainObject(overlay)) return (overlay as unknown as T) ?? base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(overlay)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v as DeepPartial<unknown>) : v;
  }
  return out as T;
}

// Apply a vertical's overlay to an already-resolved base dictionary. Returns the
// base unchanged when the vertical overrides nothing for this locale — so the
// INTERNSHIP path and every not-yet-dressed locale cost nothing and stay
// referentially identical.
export function applyVerticalOverlay<T extends object>(
  base: T,
  locale: Locale,
  vertical: VerticalKey | null | undefined,
): T {
  const v = vertical ?? DEFAULT_VERTICAL;
  if (v === DEFAULT_VERTICAL || !hasOverlay(v, locale)) return base;
  return deepMerge(base, OVERLAYS[v][locale] as DeepPartial<T>);
}

// Exposed for two guards. scripts/check-i18n.ts (node, at the PR gate) flattens
// these to assert every overlay key already exists in the base and that
// INTERNSHIP is empty. The compile-time half is stronger and needs nothing
// here: `LocaleOverlay = DeepPartial<Dictionary>` over `typeof en` makes a
// misspelled overlay key a TS excess-property error, caught by `tsc --noEmit`
// in CI — so a typo is a build failure, and check-i18n is defence-in-depth plus
// the one thing types cannot see (a valid override wrongly placed in the empty
// INTERNSHIP entry).
export function overlayEntries(): { vertical: VerticalKey; locale: Locale; overlay: LocaleOverlay }[] {
  const out: { vertical: VerticalKey; locale: Locale; overlay: LocaleOverlay }[] = [];
  for (const vertical of Object.keys(OVERLAYS) as VerticalKey[]) {
    for (const locale of Object.keys(OVERLAYS[vertical]) as Locale[]) {
      out.push({ vertical, locale, overlay: OVERLAYS[vertical][locale] });
    }
  }
  return out;
}
