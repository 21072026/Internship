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
// matches nothing is a silent no-op, so it is a build error instead). It covers
// every string a MARKETING tenant can reach that the base phrases in internship
// words — and only those; a namespace MARKETING cannot render is argued into
// LEAK_EXEMPT in scripts/check-i18n.ts instead of being dressed here.
//
// How far it has got is measured, not guessed (#2558): scripts/check-i18n.ts
// counts the MARKETING-resolved values that still contain an internship word
// and pins that count — now at zero — so a new un-overlaid "mentor" string a
// MARKETING tenant can reach fails the check.
// E-mails read this same overlay through src/i18n/emailDictionary.ts, keyed on
// the recipient's org; there is no second terminology layer for mail.
//
// THE PRODUCT NAME IS NEVER WRITTEN HERE (#2936). A sentence that names the
// product says `{product}` — the same token, with the same meaning, the base
// dictionary already uses — and applyVerticalOverlay() fills it while merging,
// from the caller's brand: a page passes the request brand's name, a mail the
// recipient organization's, llms.txt the host's (src/lib/hostBrand.ts). The
// name is therefore data (an organization's brand, else the vertical default)
// and one overlay serves every tenant of a vertical.

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
      // Document requirements: the role picker names the seats, not the enum.
      documentRequirements: { search: 'Search leads', roles: { MENTEE: 'Lead', MENTOR: 'Sales rep', COMPANY: 'Account' }, reviewerRoles: { MENTOR: 'Sales rep' } },
      // The follow-up panel (#2563) in the rep's words (#2875): the sales
      // example the base dictionary used to carry, and who reads the note.
      followUp: {
        notePlaceholder: 'e.g. Call about pricing',
        visibility: 'Only the owner of this record and the admins see this note; the contact never does. On the day, the owner gets one reminder.',
        aiHint: 'Three suggestions from the activity log and the stage (uses one AI credit). Pick one, edit it, save.',
        aiEmpty: 'No activity logged yet — add one first.',
      },
      // The ROI screen's donated-time inputs (#1895), in the rep wording.
      roi: {
        screen: {
          mentorHours: 'Unbilled rep hours to price',
          hints: {
            mentorHourValue: 'Prices donated rep time so a volunteer-run programme does not look free.',
            mentorHours: 'Leave at 0 unless your organisation counts donated rep time as a cost.',
          },
        },
        categories: {
          MENTOR_TIME: 'Sales rep time',
        },
        steps: {
          mentorTimeCost: 'Unbilled sales rep time',
        },
        assumptions: {
          mentorHourValue: 'Value of one sales rep hour',
        },
      },
      // #1376: the MARKETING home title comes from the root layout's own
      // branch; these keep the internship copy out of the resolved dictionary.
      seo: {
        homeTitle: '{product} — Marketing CRM',
        homeDescription: 'A CRM for tracking customers through a marketing pipeline — from first contact to close.',
        applyAsMentorTitle: 'Apply',
        applyAsMentorDescription: 'Apply to join the programme.',
        profileMentorTitle: '{name}',
        profileMenteeTitle: '{name}',
      },
      // Survey results (#1910): the breakdown labels name the roles, so they
      // take the same rep/lead words as everywhere else.
      // Goal sharing scope (#1858): the option names the two seats.
      goals: {
        visibilityPair: 'Sales rep and lead',
        visibilityProgram: 'Sales rep, lead and team',
        byMentor: 'Created by sales rep',
        byMentee: 'Created by lead',
      },
      surveyResults: {
        byMentor: 'By sales rep',
        noRelationBreakdowns: 'Anonymous responses carry no cohort or owner, so those breakdowns do not exist for this survey.',
        role_MENTEE: 'Leads',
        role_MENTOR: 'Sales reps',
        audience_BOTH: 'Leads and sales reps',
        createOnePerRole: 'This instrument asks sales reps a differently worded question, so it is one survey per role — create a second one for the other role.',
      },
      nav: {
        candidates: 'Leads',
        companyInquiries: 'Demo requests',
        myCompanies: 'My accounts',
        mentorDirectory: 'Sales reps',
        mentors: 'Sales reps',
        mentorships: 'Deals',
        myMentees: 'My Leads',
        inviteMentee: 'Invite a lead',
        menteeActivity: 'Lead Activity',
        mentorApplications: 'Sales Rep Applications',
        agreements: 'Engagement agreement',
      },
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
        automationEmail: { mentorCheckIn: { cta: 'Open my leads' } },
        invitationEmail: {
          roles: { MENTOR: 'a sales rep', MENTEE: 'a lead' },
        },
        slaEscalationEmail: {
          body: 'The stage deadline for {mentee} passed {days} days ago and the stage has not moved since. The rep, {mentor}, was reminded when it passed. Acknowledge it on the SLA queue if it is in hand.',
        },
        events: {
          'interaction.logged': 'A new interaction note was added.',
          'deadline.slaEscalated': '{menteeName} has been past the stage deadline for {days} days and the stage has not moved (rep: {mentorName}).',
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
          'outcome.needsMessage': '{name} reached an outcome stage. Write them a message.',
          'duplicate.suspected': 'A new record may duplicate an existing lead: {name}.',
          'outcome.placedElsewhere': 'Congratulations on your next step! Your journey here is marked as complete — the door stays open whenever you need us.',
          'goal.assigned': 'A new goal was added to your deal: "{title}".',
          'evaluation.added': 'A new evaluation was added about your deal.',
          'mentorship_request.new': 'New contact request from {from}.',
          'mentorship_request.newGeneric': 'A new contact request was received.',
          'mentorship_request.approved': 'Your contact request was approved — say hi to your contact person!',
          'mentorship_request.rejected': 'Your contact request was reviewed but could not be approved right now.',
          'mentorship_request.rematch': '{from} asked for a different contact person.',
          'mentorship_request.rematchGeneric': 'A lead asked for a different contact person.',
          'mentorship_request.rematchApproved': 'You have a new contact person — your previous one no longer looks after you.',
          'mentorship_request.rematchRejected': 'Your request for a different contact person was reviewed. Your current contact person stays with you for now.',
          'mentorship_request.rematchMentorNotice': 'Your deal with {menteeName} has ended — they are continuing with another rep.',
          'application.received': '{name} signed up as your lead.',
          'mentor_application.new': '{name} applied to join as a sales rep.',
          'mentor_application.approved': 'Your sales rep application was approved — welcome aboard!',
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
        types: {
          mentorship_request: 'Contact request',
          mentor_application: 'Sales rep application',
        },
        rematchRequestedEmail: {
          subject: 'New contact person requested: {name}',
          heading: 'New contact person requested',
          body: '{name} has asked for a different contact person. Their current deal stays active until you decide.',
          privacy: 'The reason they gave is in the admin queue and is not shared with their current rep.',
        },
        rematchMentorEmail: {
          subject: 'Your deal with {name} has ended',
          heading: 'A deal has ended',
          body: 'Your deal with {name} has ended. They are continuing with another rep.',
          thanks: 'Thank you for the time and care you gave. Your other leads are unaffected.',
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
      // The SSO role-mapping card (#2839): its hints named the enum (MENTEE,
      // ADMIN), which the leak ratchet strips as a code — so nobody dressed them.
      organizations: {
        ssoRoleMappingsHint: 'A user whose claim contains the value gets that role. The highest priority wins; a tie gives the lower role. No match: lead. Admin cannot be mapped yet.',
        ssoRoleNone: 'No mappings yet — every SSO user starts as a lead.',
        ssoRoleSyncHint: 'Off: an existing user keeps the role they have. On: their role follows the mapping at each sign-in (never for an admin, and a login that matches nothing changes nothing).',
        relations: 'Deals',
      },
      candidateDetail: {
        mentorship: 'Owner',
        notAssigned: 'No rep owns this lead yet',
        mentor: 'Rep',
      },
      // The suggested first messages in an empty thread (#2557). The rep's set
      // (welcome/introCall/goals) and the lead's set (hello/intro/question) keep
      // their `{name}` placeholder; the words are a sales conversation about a
      // product demo and trial, not an internship.
      messages: {
        openers: {
          welcome: {
            label: '👋 Welcome',
            text: 'Hi {name}, thanks for your interest in {product}! I am your contact from here on — write to me in this chat whenever something comes up.',
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
        pilotBody: 'We open the account and connect the leads you already have, and we delete your data the day you ask. What it costs is published rather than negotiated, so you can check the number before anyone quotes you one.',
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
      // Public chrome + auth pages (#2501): the footer tagline and the
      // sign-in/register copy a marketing visitor reads. The header wordmark
      // needs no entry — it names itself from `productNameFor()` (#2967).
      publicNav: {
        tagline: 'Leads, accounts and deals in one pipeline — from first contact to close.',
        becomeMentor: 'Join as a sales rep',
      },
      auth: {
        signinSubtitle: 'Sign in to your {product} account',
        registerSubtitle: 'Register with your invitation',
        tokenHint: 'Paste the invitation token from your e-mail. Accounts on this product are created by invitation.',
        dataSharingTitle: 'How your data is shared',
        dataSharingBody: 'Depending on your role, the details you add may be visible to others: a lead’s details and activity history are seen by the assigned rep and by admins. Reps see only their own leads and accounts. See the privacy notice for details.',
        wantMentor: 'Want to become a sales rep?',
        becomeMentorPrompt: 'Want to become a sales rep instead?',
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
          mentorCapacity: 'Set your lead capacity',
        },
        guides: {
          profile: 'Your details and your skills are what a sales rep reads before you ever speak. A filled-in profile gets routed to the right person; an empty one waits. Five minutes now saves a first call spent on questions you could have answered in writing.',
          cv: 'A CV or company profile is what your sales rep actually reads. Upload the version you would send today even if it is not perfect. Keep it to facts that are true and checkable.',
          public: 'A public profile is a page others can find that carries no phone number, no e-mail and no address. It is optional and reversible: switch it off and the page is gone the same second.',
          bio: 'Two or three sentences about what you do and what you can help with are enough. A lead reads this before anything else, and something concrete helps more than a job title. Write it the way you would say it out loud.',
          interestsOrSkills: 'Routing runs on this. Naming the areas you know — and the ones you enjoy — is what puts a fitting lead in front of you instead of a random one. Two or three specific entries beat ten vague ones.',
          mentorCapacity: 'Capacity is how many leads you are willing to own at once, and the team respects it: an admin sees it before assigning anybody to you. Set it low and honestly — one well-followed lead is worth three neglected ones. You can raise it any time.',
          availability: 'An availability slot is a recurring window in which you are happy to be booked, in your own timezone. A couple of them let a lead pick a time without a chain of “does Tuesday work?” e-mails. A slot is a window, not a promise: nothing is in your calendar until you accept the booking.',
          configurePipeline: 'The pipeline is the row of stages every lead moves through, from first contact to won. Keeping the built-in stages is a perfectly good decision — which is why this step is optional. Rename or reorder them only if your team genuinely counts differently: every board column, report and service level is built on these stages.',
          documentRequirements: 'Many teams collect paperwork — a signed agreement, an order form, a compliance certificate. Declaring them here turns “chase everyone by e-mail” into a list the app tracks and reminds about, per stage and per role. Only add documents you truly need: each one is work you are asking a customer to do.',
          evaluationTemplate: 'The evaluation framework is the handful of criteria your team scores a lead or a deal on. Writing them down before the first evaluation is what makes two reps’ scores comparable. Three to six criteria is plenty, and the built-in rubric is a fine starting point while you have no strong opinion.',
          inviteMentors: 'Invite your sales reps first: a lead without an owner waits, a rep without leads just has a quiet week. Invite people who already said yes in person — the e-mail is the paperwork, not the ask. Ask each of them to set their capacity and availability once they are in.',
          inviteMentees: 'Add the leads you already have in one batch rather than a trickle — a pipeline only tells you something once there are people in it. Nobody sees anybody else’s data.',
          addCompany: 'Accounts are the companies you sell to, and the last stages of the pipeline mean nothing without at least one. Add the ones you already talk to, with a contact address, before you need them. Recording what an account is looking for lets the fitting lead surface later instead of being remembered by luck.',
          assignMentorship: 'This is the moment the pipeline starts: one rep, one lead, and from then on a shared history of calls, notes and stage changes. Create the first deal as soon as both sides exist — an owner that turns out wrong is easy to change. Every board, report and reminder is built on these deals.',
          firstInteraction: 'A logged interaction — a call, an e-mail, a meeting — is how the team remembers what was said. The first one matters most: it is what a colleague reads before taking a lead over, and what the reminder job measures silence against. Log it right after the conversation. This step is optional: it is a milestone, not part of the setup.',
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
        selfMatchLimitHint: 'How many leads may pick you themselves (directory request or your link). Blank = same as your capacity. Admins can still assign you up to your capacity. A personal preference, never a plan limit.',
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
      // The report registry (#1903): the mentorship-only reports are refused for
      // a tenant without `mentorship`, but the column labels are shared.
      reports: {
        mentorWorkload: { title: 'Rep workload', description: 'Active deals per rep and how many reached the final stage.' },
        weeklyReportCompliance: { description: 'Owed, handed-in, missing and late weekly reports per person this term.' },
        col: { mentor: 'Rep', intern: 'Person' },
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
      // carry their own en/tr/de labels; the stored (single-language) copy is
      // read back in the viewer's locale by localizeResolvedStageLabels()
      // (src/lib/programTemplates.ts, #2710). A second
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
      panel: {
        sales: 'Sales',
        mentor: 'Rep Portal',
        mentee: 'Lead Portal',
      },
      sales: {
        dashboard: { title: 'Your sales pipeline', subtitle: 'Your own leads and accounts, and what needs you today.' },
        stats: { open: 'Open leads', accounts: 'Accounts' },
        records: {
          title: 'My leads',
          empty: 'No leads on your board yet. Create one with “New lead”, or an admin — or the default lead owner setting — assigns them to you.',
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
        dashSubtitle: 'Here\'s an overview of your leads and interactions',
        activeMentees: 'Active Leads',
        myMentees: 'My Leads',
        currentRelationships: 'Current active deals',
        noActiveMentees: 'No active leads assigned',
        exampleLogNote: 'Discussed progress on the current proposal and next steps for the deal.',
        goToMenteeToLog: 'Go to a lead\'s detail page to log an interaction',
        interactionSearchPlaceholder: 'Search subject, notes or lead...',
        menteeDormantMatchOne: '1 dormant lead matches this filter and stays hidden.',
        menteeDormantMatchMany: '{n} dormant leads match this filter and stay hidden.',
        menteesSubtitle: 'All your deals',
        noMenteesAssigned: 'No leads assigned yet',
        noMenteesHint: 'Add your first lead or share your application link to start.',
        interactionLogsSubtitle: 'All your logged interactions with leads',
        backToMentees: 'Back to leads',
        addMentee: 'Add Lead',
        newMentee: 'New Lead',
        menteeCreated: 'Lead created',
        setPwLinkHint: 'We emailed the lead a link to set their password and activate their account. If it doesn’t arrive, share this link with them directly:',
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
        candidates: {
          adminBody: 'Everyone who signs up or accepts an invitation lands in this list, together with their rep, account and stage. Send the first invitation and the list fills itself.',
        },
        requisitions: {
          companyBody: 'A requisition tells the reps which position you are hiring for, how many people you need and which skills matter. Create one and matching people can be proposed to you.',
        },
        interviewRequests: {
          mentorBody: 'When an account asks to meet one of your leads, the request appears here with the proposed times, and you arrange the meeting from there.',
        },
        weeklyReports: {
          menteeBody: 'A weekly report is a short note about what you did, how long it took and what is blocking you. Write the first one in the form above so your contact person can comment on it.',
          mentorBody: 'Weekly reports appear here as your lead submits them, newest first, and you can approve one or ask for changes. Nothing has been submitted yet.',
        },
        documents: {
          mentorBody: 'Your lead has not uploaded anything yet. Their contracts, order forms and certificates appear here as they arrive, with the version history kept.',
          menteeBody: 'This is where your contracts, order forms and certificates live. Upload the first one below and your contact person can see it right away.',
        },
        portalGoals: {
          title: 'No contact person assigned yet',
          menteeBody: 'Goals, evaluations and weekly reports all belong to a deal, so they open up once an admin assigns you a contact person. A complete profile makes that faster.',
        },
        todos: {
          body: 'This list holds what your contact person handed you, what your projects need and whatever you add yourself. Write the first line in the box above.',
        },
      },
      landing: {
        // The lean marketing landing (#2500): the sections that survive for a
        // MARKETING host — hero, chips, feature cards, the funnel diagram, "and
        // more", transparency, CTA — re-worded for a sales team. The internship
        // argument (role picker, free core, stories, FAQ) is not rendered for
        // this vertical; its keys are overlaid only so the leak ratchet in
        // scripts/check-i18n.ts can stay at zero for the whole namespace.
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
        pipelineNote: 'Not every lead closes: lost deals are recorded too, so the funnel tells you the truth.',
        stageApply: 'New lead',
        stageInterview: 'Contacted',
        stageInternship: 'Proposal sent',
        stageHired: 'Won',
        ctaTitle: 'Ready to see every deal in one place?',
        ctaSubtitle: 'Set up your pipeline in minutes — your team signs in with an invitation.',
        ctaMentee: 'Sign in',
        trans5T: 'Consent as a mechanism',
        trans5D: 'Customer data is shown to nobody outside your team; every consent is recorded with its version and revocable at any time. Email and phone never appear on any public page.',
        badge: 'Marketing CRM · Track leads · Close deals',
        heroTitle: 'Every lead, every conversation, every deal —',
        heroAccent: 'in one pipeline.',
        heroSubtitle: 'Track your customers from first contact to close. See where every deal stands, who touched it last and what to do next — instead of piecing it together from a spreadsheet.',
        featuresTitle: 'Everything your team needs to close',
        becomeMentor: 'Want to join as a sales rep?',
        fMentorT: 'Rep self-service',
        fMentorD: 'Reps add their own leads, log meetings, feedback, emails, calls and WhatsApp chats, keep private notes, and get a needs-attention queue on their dashboard — admins can do it all too.',
        fGrowthD: 'Deal projects with task lists and progress, personal goals, structured interim and final evaluations in both directions, and built-in Q&A between lead and rep.',
        roleMentor: 'Sales rep',
        roleMentee: 'Lead',
        heroModel: 'One price per user — no hidden add-ons.',
        freeCoreBody: 'Messages, meetings, goals, evaluations and the whole pipeline are part of every plan — billed per user, with no hidden add-ons.',
        liveMentors: '{n} sales reps',
        liveWaiting: '{n} leads waiting for a rep',
        pickMenteeT: 'I am looking for a solution',
        pickCompanyD: 'Meet the lead through the rep who has worked with them for months.',
        audCompanyTitle: 'Meet the lead through the sales rep who worked with them for months, not through a CV.',
        audCompanySubtitle: 'Follow your leads from day one and make the decision from a written record spanning months instead of two calls. We are in a pilot: we open the account, we charge nothing, there is no contract.',
        audCompany1T: 'Where is your lead, and how is it going?',
        audCompany1D: 'One screen shows every lead linked to your account: which stage they are at, who their sales rep is, and the shape of the funnel. Meeting notes and goals are kept by the rep; you read the status and the rep’s periodic evaluation. You do not get write access — so the side keeping the record stays impartial.',
        audCompany2D: 'The process runs on a single line: deal starting → deal in progress → ready to close → won. You get to know the lead through months of real work rather than one call performance.',
        audCompany3D: 'The lead already has a sales rep: someone who sets goals, meets them regularly, writes down their progress and produces periodic evaluations.',
        audCompany4T: 'A lead report card with a sales rep’s name on it.',
        audCompany4D: 'For every lead who starts a deal with your account, their sales rep files two evaluations — interim and final — with a score and a written comment under four headings: technical, communication, reliability, growth. Next to it sit the real project tasks the lead completed. The report card is the product of time spent together: the pool is where you meet someone, not where you decide. Account access to evaluations is a premium permission and is opened by hand today.',
        stories: {
          roles: {
            mentor: 'Sales rep',
            mentee: 'Lead',
          },
        },
        faqMentee5A: 'A lead never pays anything. The team that follows up with you pays per user — we sell them the software, not your data.',
        faqCompany1A: 'We open the account and connect your current leads ourselves; we do not send you a link until there is at least one real lead in the panel.',
        ctaMentor: 'Apply as a sales rep',
      },
      // The public feature catalogue (#2475). `/features` renders whatever
      // getFeatures() returns for this vertical; the cards themselves are
      // filtered by capability in src/lib/features.ts, and what is left here is
      // the frame plus the four core cards whose wording still said
      // "mentor"/"mentee"/"mentorship" although the feature itself is core CRM.
      featureCatalog: {
        title: 'Everything {product} can do',
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
          pricing: {
            d: 'The price list is on the website, not in a quote: plan bands, admin seats, the overage rate and every add-on. One metering unit — the active deal — so sales reps and leads are structurally unbillable, and the page states what is never metered at any tier.',
          },
          rematch: {
            t: 'Ask for a different contact person',
            d: 'A lead whose deal is not working out with their rep can ask the team for a different contact person, with a reason category and an optional note. The current deal stays fully live until an admin decides, the swap happens in one step so nobody is ever left without a contact person, and the outgoing rep is told the deal was handed over — never what was written about them.',
          },
          activityReport: {
            d: 'Consent-based lead activity digests for sales reps and admins: logins, time on site, pages visited and completed to-dos.',
          },
          menteeOwnProject: {
            d: 'A lead is not only assigned to projects — they can start one. Creating a project from the portal makes the creator its owner: they edit every field and run its to-dos. Their own project starts private, so it is a team of one until an admin adds someone or publishes it to the public showcase — from then on the owner grows the team by approving join requests.',
          },
          menteeInsights: {
            d: 'The activity summary a lead’s sales rep and team read is also theirs to read, on their own page in the portal: goals, meetings, interactions, stage moves and messages, plus time on site and visited pages while activity tracking is on. No comparison to anyone else, no score, and never a paid feature.',
          },
          publicProfiles: {
            d: 'Leads and sales reps can opt in to a public, PII-free profile page — and when its link is shared on LinkedIn, WhatsApp or Slack, it unfurls into a branded card with name, role, location and top skills.',
          },
          interviewRequests: {
            d: 'Accounts shortlist leads per requisition and request interviews; the team or the assigned sales rep reviews each request before scheduling.',
          },
          aiPackage: {
            d: 'CV feedback and interview prep for leads, interaction-log summaries for sales reps, AI-assisted assignment, and themes across evaluation comments and weekly-report blockers for admins — each theme linked to the rows behind it. All consent- and quota-gated.',
          },
          matchingRules: {
            d: 'Decide what makes a good sales rep assignment — skills, language, field, city, time zone, capacity — and how much each counts, mark the non-negotiables, and never assign a person to their own manager or a past contact person. A dry run shows who would be assigned to whom before you commit, and names the rule that is too tight. Every score explains itself rule by rule.',
          },
          matchQuality: {
            d: 'Every sales rep suggestion the platform makes is recorded with the position it was shown at, and a one-click dismissal asks why — wrong field, no capacity, language, already assigned. The analytics page then answers the question every team owner eventually asks: how often is the suggestion actually taken, and does the top-ranked rep really get picked? The suggestion stays a suggestion — a person always decides.',
          },
          selfServe: {
            t: 'Self-serve lead intake',
            d: 'Leads sign up on their own, complete onboarding and request a contact person; admins approve from a queue.',
          },
          outcomeComms: {
            d: 'When a deal ends, the portal says where things stand and what to do next instead of quietly changing a status, and the sales rep is handed a ready-to-edit message rather than a blank page. Automatic sending is off by default — a person reads every rejection before it goes out. A lead who finds what they need elsewhere is not treated as a failure, and gets its own wording.',
          },
          joinRequests: {
            d: 'Public projects accept join requests the owner approves in one click, and everyone — lead, sales rep or admin — has a personal invite link that records who brought a newcomer in.',
          },
          todos: {
            d: 'Everything someone has to do in one place: what their sales rep handed them, what their projects need, the open project goals they can claim, and what they wrote for themselves — finished ones archived rather than deleted. A to-do from the shared, multilingual pool stays linked to it: reword the pool entry once and it changes for everyone who has it, in each person’s own language. Each to-do can carry a due date: the soonest come first and undated ones last, a late one is marked “overdue” in words as well as in colour, and a sales rep or admin can read one list of everything their people are carrying.',
          },
          dualRole: {
            d: 'A sales rep can be a lead too. Someone who looks after others may still need a contact person themselves — give a rep a rep of their own and the lead portal opens up next to their sales pages, with a view switch in the sidebar to move between them. Admins can put anyone on either side of a deal; nobody can be paired with themselves.',
          },
          weeklyReports: {
            t: 'Weekly lead reports',
            d: 'Leads write a weekly report, keep drafts and print their diary; sales reps review each submission, approve it or request changes. Missing reports surface in the rep attention queue and a weekly reminder; coordinators get a term-wide compliance matrix with a one-click reminder, an XLSX export and a printable report booklet per lead.',
          },
          newsletter: {
            d: 'Short, emoji-led issues of CV and interview advice, written once in English, Turkish and German and sent to each reader in their own language. Send by hand or on a weekly, fortnightly or monthly schedule; sales reps get a coaching angle on the same issue, every send is kept on the record, and one press unsubscribes.',
          },
          mentorSelfApply: {
            t: 'Self-serve sales rep applications',
            d: 'Anyone can apply to become a sales rep without an account; admins review, take into review, approve or reject from a queue, and approval creates or upgrades the rep’s account automatically.',
          },
          offers: {
            d: 'Create, preview and send an offer from a lead’s deal card in three steps; the lead accepts or declines (with a reason) from their portal, sees a persistent decision state, and overdue offers expire on their own — every step logged and notified. An admin offer index answers what is still outstanding, what expires this week and what was declined, and why.',
          },
        },
      },
      // /pricing (#2475). The marketing price list is the host organization's
      // data (#2927, src/lib/marketingPriceList.ts); the internship
      // sections stay hidden there (see src/app/pricing/page.tsx) and these
      // strings frame the page for a sales team.
      pricing: {
        heroBadge: '{product} pricing',
        heroTitle: 'One price per user, no surprises',
        heroSubtitle: 'Plans for sales teams, billed per user. No hidden add-ons — and if you would rather run it yourself, the code is open source.',
        discountsTitle: 'What is already true',
        freeTitle: 'Billed per user, no surprises',
        freeBody: 'Plans are billed per user on the sales team. There are no hidden add-ons — every plan and its limits are listed on this page.',
        neverMetered: {
          messaging: 'Messages between sales rep and lead',
          portal: 'The lead portal',
        },
        planDesc: {
          employer_free: 'A brand page and answering a rep-approved shortlist.',
        },
        meteringCounted: 'Counted: a deal in ACTIVE state with any logged activity during the calendar month.',
        meteringNeverCounted: 'Never counted: sales reps and leads. They are not a unit we can meter.',
        employerSubtitle: 'A separate wallet, bought by a different buyer. Nothing here changes what a team pays, and nothing an account pays reaches the lead side.',
        faq1Q: 'Do sales reps or leads ever pay?',
        faq1A: 'No, and not as a policy we could quietly change — they are not the metering unit. There is no rep seat and no lead seat to sell.',
        faq2A: 'One sales rep assigned to one lead, in ACTIVE state, with at least one logged activity in that calendar month. A deal you paused is not counted, and a deal that finished stops counting the month it finishes.',
        ctaMenteeT: 'I want a sales rep',
        ctaMentorT: 'I want to work leads',
        ctaMentorA: 'Apply as a sales rep',
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
      slaQueue: {
        colOwner: 'Rep',
        levelMentor: 'Rep told',
        complianceDefinition: 'Of the stage moves made in the period out of a stage that has a service level, the share made before that service level elapsed — measured from when the lead entered the stage, in calendar days, against the service levels configured today. Leads in the re-engagement pool and stages whose clock is stopped are not counted.',
      },
      stageSla: {
        escalateHint: 'Escalate after: if a stage is still overdue this many days after its deadline passed, the organisation’s administrators are told too — once. Leave it empty and only the rep is reminded, as before.',
        scopeMentor: 'Rep',
        allMentors: 'Every rep',
        overrideHint: 'You are editing an override. For these records it beats the organisation’s number — rep and cohort together, then rep, then cohort, then the organisation. Leave a stage empty to inherit. An empty escalation inherits too; board limits stay organisation-wide.',
        sourceMentor: 'this rep',
        sourceMentorCohort: 'this rep in this cohort',
        subtitle: 'How long anyone may wait at a stage before the rep is warned. Leave a stage empty and it has no rule — an organisation that sets none keeps working exactly as before.',
      },
      // The public pages every footer links to (docs/worlds.md): the share
      // target, the public profile's wordmark and the legal/trust/accessibility
      // statements named "InternshipCRM" and described mentorships and
      // internships to a MARKETING visitor. Only the sentences that name the
      // product or its relation model are replaced; the legal substance
      // (controller, rights, retention, subprocessors) is the same codebase's.
      share: { title: 'Shared with {product}' },
      publicProfile: {
        poweredBy: '{product}',
        mentor: 'Sales rep',
        activeMentees: 'Active leads',
        evaluationTitle: 'Sales rep evaluation',
        evaluationByMentor: 'sales rep',
      },
      imprint: { intro: 'Who runs this {product} instance, and how to reach them.' },
      privacy: {
        intro: 'We store the information you provide in order to manage leads, accounts and deals. This notice explains what we process, why, who can see it, how long we keep it, and your rights (GDPR Arts. 13–15).',
        controllerBody: 'The controller for the personal data processed here is {operator}, the operator of this {product} instance. The postal address and any further contact details are published in the imprint.',
        controllerUnset: 'The controller is whoever operates this {product} instance; their details are published in this deployment’s imprint.',
        purposesBody: 'To operate the platform: tracking leads and accounts through the sales pipeline, assigning them to sales reps, logging interactions, scheduling and communication. When a sales rep copies this CRM’s address on an e-mail to you (BCC), or forwards your reply to it, the date, the subject and the e-mail addresses involved are recorded as an interaction on your account; the content and attachments are not stored.',
        legalBasisBody: 'Processing relies on your consent (Art. 6(1)(a)) and on the legitimate interest of running the sales process (Art. 6(1)(f)). Optional processing always requires separate consent.',
        recipientsBody: 'Depending on your role: a lead’s record and interaction history are visible to the sales rep who owns it and to administrators. Reps see only their own leads and accounts. We never sell your data. On the public home page, and only after you accept marketing cookies, the live chat is loaded from tawk.to — it receives your IP address and whatever you type into the chat. Decline, or leave the chat alone, and nothing is sent to them.',
        use: 'Your data is used only to operate the platform — pipeline tracking and communication.',
        aiBody: 'One feature can send text to an AI provider: when an administrator assigns a lead to a sales rep, the rep suggestion sends the lead’s skills, position and interests and up to five reps’ skills, interests and current load, with no name or identifier on either side. It asks for no consent because nothing identifying anyone is sent, and an administrator can switch it off for the whole organisation. Neither the text sent nor the text generated is stored. What it sends, what it deliberately withholds and who the provider is are set out in full on the AI page.',
      },
      terms: {
        intro: 'By using {product} you agree to these terms.',
        use: 'Use the platform only for lawful customer and sales management.',
      },
      trust: {
        operatorUnset: 'This instance has not published an operator yet. {product} is open source and every deployment names its own operator in its own imprint.',
        posture: {
          dataD: 'Your data is not sold. There is no payment processor, no ad network and no data broker anywhere in the codebase.',
          crmD: 'Analytics and live chat are mounted from the public shell only, never from the application itself. A signed-in pageview would carry a lead’s name to a vendor, so it cannot happen.',
        },
        residencySelfHost: '{product} is licensed AGPL-3.0-or-later. You may run your own instance, on your own infrastructure, in your own jurisdiction, without asking permission and without paying anyone. That is the strongest data-residency guarantee this project can offer, because it removes us from the question entirely. Dual licensing is available from the rights holder, Mehmet Erşahin — a natural person, not a company.',
        freeNote: 'Nothing on this page is a paid add-on.',
      },
      accessibility: {
        intro: 'We build {product} so that a sales rep, a manager or an administrator can use it with a keyboard, a screen reader, a magnifier, or a phone held at arm’s length. This statement says which standard we measure ourselves against, how we check, what does not work yet, and who to write to when you hit a barrier.',
        scopeBody: 'The {product} web application served from this deployment: the public pages, the sign-in flow, and the rep and admin areas behind it. It does not cover files that users upload, e-mail as rendered by someone else’s mail client, or the third-party services named further down.',
        evidence: {
          dragAlternative: 'The pipeline board can be operated without drag-and-drop: every card carries a stage select that moves the deal with the keyboard alone.',
        },
        limitations: {
          thinFixture: 'The automated scan runs against the shared codebase in its default product configuration, so the screens and wording only {product} shows are not yet under the automated gate.',
        },
      },
      // /ai and the privacy notice's AI section described five features, four
      // of which live in the mentorship shells this vertical does not have.
      // What a MARKETING tenant can reach is the rep suggestion on the leads
      // list (AssignMentorInline → /api/admin/mentor-suggest), so that is the
      // one feature named. Arrays are replaced whole by the overlay merge.
      ai: {
        intro: 'One feature in this product sends text to a language model run by a third party. This page names it, says exactly what leaves our server and what deliberately does not, and — where we have not yet done something a reviewer would like us to have done — says that too.',
        tasks: [
          {
            name: 'Rep suggestion',
            audience: 'For administrators, when assigning a lead to a sales rep.',
            sent: 'A lead’s skills, position and interests, and up to five reps as anonymous letters A–E with their skills, interests and current load.',
            withheld: 'Every name, e-mail address and identifier on both sides. The letters are matched back to real people on our own server, after the answer comes back.',
            consent: 'None is asked, because nothing identifying anyone is sent.',
          },
        ],
        consentBody: 'The feature above sends nothing that identifies anyone, so it asks nobody for consent. Nothing else in the product depends on it — no core flow needs AI, and with AI switched off every feature you already had keeps working.',
        humanBody: 'No model sets a pipeline stage, accepts or rejects anyone, makes an offer or changes an account. The rep suggestion is ranked first by a plain rule — shared skills, then who has room — and the model only re-orders that shortlist and adds one sentence of reasoning; an administrator reads it and chooses.',
        retentionBody: 'Neither what is sent nor what comes back is stored. Generated text is shown in your browser and is gone when you reload. For each call we store a single metering row — which feature, when, which account — with no prompt, no output and no excerpt of either, so the monthly limit can be counted without keeping anyone’s data.',
        notYet: [
          'We hold no SOC 2 or ISO 27001 certification for this application.',
          'We have signed no separate data-processing agreement and no zero-retention agreement with the AI provider; we use their published commercial terms.',
          'We cannot promise a processing region — requests are served wherever the provider serves them.',
          'We have published no evaluation measuring how accurate or how biased the rep suggestion is.',
        ],
      },
      programTemplates: {
        blockers: {
          strandedRelations: 'Some leads are on stages this template does not contain. Move or complete them first — applying now would leave them on a stage that no longer exists.',
        },
        items: {
          canonical_pipeline: {
            name: 'Canonical placement pipeline',
          },
          graduate_internship: {
            name: 'Graduate programme',
            desc: 'Application, screening call, match with a host team, the programme itself with a midpoint check, and a hiring decision at the end. Eight stages, service levels and two required documents.',
          },
        },
      },
      certificate: {
        title: 'Completion certificate',
        signatureTitlePlaceholder: 'e.g. Sales rep',
        success: 'Certificate generated and saved to the lead’s documents.',
      },
      matchFeedback: {
        reportSubtitle: 'Rep suggestions over the last {n} months.',
        reportEmpty: 'No rep suggestions recorded yet.',
      },
      duplicates: {
        mergeErrors: {
          linked_by_mentorship: 'These two records are linked by a deal, so they are not the same person. Resolve that first.',
          active_mentor_conflict: 'Both records have an active rep ({a} and {b}). Close one of the two deals first, then merge — we will not decide for you which rep is the real one.',
        },
      },
      availability: {
        subtitle: 'Your recurring weekly slots for lead meetings',
        zoneUnset: 'You have not set a time zone yet, so these hours are read as {zone}. Set yours so leads see the right time.',
      },
      apiDocs: {
        candidatesHint: 'Returns up to 200 leads with their current pipeline stage.',
      },
      projects: {
        subtitle: 'Projects — account-backed or team-run',
        ownerMentor: 'A sales rep',
        ownerMentee: 'A lead',
        members: 'members',
        showcaseSubtitle: 'Team and account projects.',
        noPublicHint: 'Want to get involved? Ask your sales rep about projects you can join.',
        manageOwners: 'Manage owners & reps',
        roleMentorMember: 'Sales rep',
        roleMentee: 'Lead',
        addMenteeMember: 'Add a lead (with a role)',
        noMenteesToAdd: 'No leads available to add.',
      },
      weeklyReports: {
        mentorComment: 'Sales rep comment',
        commentPlaceholder: 'Add feedback for the lead...',
        printDiary: 'Print activity diary',
      },
      meetings: {
        topics: [
          'Weekly check-in',
          'Progress review',
          'Technical demo',
          'Needs discovery',
          'Proposal walkthrough',
          'Feedback session',
        ],
        scheduledCount: 'Invite sent to {n} lead(s).',
      },
      messageTemplateAdmin: {
        subtitle: 'The replies your sales reps send over and over. Write one once, in the languages you need — a rep inserts it in their own.',
        newTemplateHint: 'Fill in at least one language. A rep gets the reply in their own language and falls back to English.',
      },
      orphanApplicants: {
        subtitle: 'Accounts the public application link created, whose sales rep declined and which show no other sign of life. They can never sign in and belong to nobody, so they are anonymised automatically {grace} days after the decision. Everything the sweep would take is listed here first.',
      },
      changeMentor: {
        action: 'Change rep',
        title: 'Change rep',
        context: 'Lead: {mentee} · current rep: {mentor}',
        hint: 'One step, one record. If nothing has been logged under this deal yet, the rep is corrected in place. If it has a history, the deal is closed as “rep changed” — never as completed — and the new one continues on the same pipeline stage. Notes, logs and messages stay with the deal they were written under.',
        newMentor: 'New rep',
        selectNewMentor: 'Select the new rep…',
        privacy: 'The reason and the note are recorded for the team — the note only in the admin audit log. Neither rep is shown them in the app; the outgoing rep is only told that the deal ended.',
        submit: 'Change rep',
        failed: 'The rep could not be changed.',
        sameMentor: 'That is already this lead’s rep.',
        inactive: 'This deal is no longer active — reload the page.',
        transferredResult: '{mentee} was handed over to {mentor} on the same pipeline stage. The previous deal is closed as “rep changed” and keeps its history.',
        reasons: {
          mentor_unavailable: 'The rep is unavailable',
          changed_goals: 'The lead’s needs changed',
          mentee_request: 'The lead asked for a change',
        },
        alreadyMentoredOffer: '{mentor} already handles this person. Change their rep instead of opening a second deal.',
        changeInstead: 'Change rep instead',
        badgeReassigned: 'Rep changed',
      },
      mentorships: {
        title: 'Deals',
        subtitle: 'Assign leads to reps and accounts',
        assign: 'Assign deal',
        searchPlaceholder: 'Search by rep, lead or account...',
        none: 'No deals yet',
        mentor: 'Rep',
        mentee: 'Lead',
        selectMentor: 'Select rep',
        selectMentee: 'Select lead',
        mentorMenteeRequired: 'Rep and Lead are required',
        assignFailed: 'The deal could not be created.',
        planLimitReached: 'Plan limit reached: {usage}/{limit} active deals on the {plan} plan. Existing leads are unaffected — upgrade to add more.',
        invalidMentor: 'That rep cannot be assigned.',
      },
      company: {
        mentor: 'Rep',
        interestHint: 'Let the rep know how you feel about this lead. They’ll be notified.',
        notePlaceholder: 'Optional note for the rep...',
        interestSaved: 'Saved — the rep has been notified.',
        verifiedTitle: 'Verified by rep',
        verifiedHint: 'Rep evaluations and project work, verified through the deal.',
        verifiedEvaluations: 'Rep evaluations',
      },
      programSurvey: {
        mentee: {
          communication: 'Was communication with your contact person there when you needed it?',
        },
        mentor: {
          support: 'Was the support you received from the team enough for your lead follow-up?',
          workloadSustainability: 'Was your lead follow-up workload at a sustainable pace?',
        },
      },
      surveyTemplates: {
        programPre: {
          q: {
            goalsMentor: 'What do you most want your lead to get out of this?',
          },
        },
        pulse: {
          q: {
            mood: 'How is the deal going right now?',
          },
        },
      },
      relationTimeline: {
        actorRole: {
          MENTOR: 'the rep',
          MENTEE: 'the lead',
        },
      },
      erasure: {
        confirmDelete: 'This will permanently delete the account and its deal history. This cannot be undone.',
      },
      todos: {
        subtitle: 'Everything on your list: what your contact person asked for, what your projects need, and what you wrote yourself.',
      },
      mentorDirectory: {
        title: 'Sales reps',
        subtitle: 'Sales reps who chose to be listed — see who could work with you',
        acceptingOnly: 'Accepting new leads',
        accepting: 'Accepting leads',
        requestMentor: 'Request this rep',
        requestedMentorUnavailable: 'That rep is no longer available — pick another one below.',
        selfMatchFullError: 'This rep is not taking self-selected leads right now — pick another one, or leave the field empty and an admin will assign you.',
        requestedMentorPending: 'You already have a request waiting for an answer, so this rep was not added to it.',
        requestedMentorActiveMentorship: 'You already have a sales rep, so this request was not started.',
        empty: 'No sales reps are listed yet. Reps appear here once they opt in.',
        noMatches: 'No sales reps match these filters.',
        loadError: 'Failed to load the sales rep directory',
        showing: 'Showing {from}–{to} of {total} sales reps',
        partialNotice: 'This list may be incomplete — only the first {cap} listed sales reps could be searched. Narrow your filters to be sure you are seeing everyone.',
      },
      sourcePortal: {
        title: 'My leads',
        subtitle: 'Submit leads you refer; a sales rep will pick them up and assign them.',
        addMentee: 'Add a lead',
        submit: 'Submit lead',
        added: 'Lead submitted',
        myMentees: 'Submitted leads',
        none: 'No leads submitted yet',
        assignedTo: 'Sales rep:',
        pending: 'Awaiting a sales rep',
      },
      matchScore: {
        dimensions: {
          capacityHeadroom: 'Rep capacity',
        },
        violations: {
          capacityHeadroom: 'The sales rep has no capacity left',
          managerExclusion: 'The sales rep is the direct manager of this lead',
        },
      },
      demo: {
        roles: {
          mentor: 'Sales rep',
          mentee: 'Lead',
        },
      },
      testimonials: {
        admin: {
          roles: {
            mentor: 'sales rep',
            mentee: 'lead',
          },
        },
      },
      tags: {
        notYourMentee: 'You can only tag your own leads.',
      },
      releaseNotes: {
        feedDescription: 'New features and improvements in {product}.',
      },
      newsletter: {
        emailMentorTitle: 'For sales reps',
        audienceMentee: 'Leads',
        audienceMentor: 'Sales reps',
        audienceBoth: 'Leads and sales reps',
        audienceHint: 'Sales reps also see the "For sales reps" block; leads never do.',
        mentorNote: 'For sales reps',
        mentorNotePlaceholder: 'What a sales rep should do with this content.',
        mentorNoteHint: 'Only shown to sales reps, and only on a sales rep or shared issue.',
        previewAsMentee: 'Lead',
        previewAsMentor: 'Sales rep',
        archiveMentorNote: 'For sales reps',
      },
      modeSwitch: {
        mentor: 'Sales rep',
        mentee: 'Lead',
        mentorHint: 'Sales rep view: only the leads you look after yourself.',
        menteeHint: 'Lead view: your own deal — the one where you are the lead.',
      },
      menteeActivation: {
        placeholderNote: 'This lead was added without an e-mail address, so they have a stand-in one and cannot sign in. Enter their real address to activate the account — the record, its interaction log and its stage history are kept.',
        noPasswordNote: 'This lead has not set a password yet. Correct the address if it is wrong, then send the activation link again.',
        mailFailedHint: 'The e-mail could not be sent. Share this link with the lead directly:',
      },
      onboarding: {
        mentee: {
          subtitle: 'Help us connect you with the right contact person and offers',
        },
        mentor: {
          title: 'Set Up Your Sales Rep Profile',
          subtitle: 'A few quick steps so leads know who you are and when you’re free',
        },
      },
      stageClock: {
        mentee: {
          expectedBy: 'Your contact person plans to take the next step by {date}.',
          reassure: 'Waiting times differ from stage to stage — if you would like an update, just ask your contact person.',
        },
      },
      evaluation: {
        titleMentor: 'Evaluate your sales rep',
        onMentor: 'On sales rep',
      },
      profileForm: {
        mentorCapacity: 'Lead capacity',
        mentorCapacityHint: 'How many leads you can take on at once',
      },
      aiSummary: {
        consentRequired: 'The lead has not allowed AI summaries. They can enable it under Account → Privacy & consent.',
      },
    },
    tr: {
      documentRequirements: { search: 'Müşteri adayı ara', roles: { MENTEE: 'Müşteri adayı', MENTOR: 'Satış temsilcisi', COMPANY: 'Hesap' }, reviewerRoles: { MENTOR: 'Satış temsilcisi' } },
      // Takip paneli (#2563) temsilci diliyle (#2875): temel sözlüğün eskiden
      // taşıdığı satış örneği ve notu kimin okuduğu.
      followUp: {
        notePlaceholder: 'örn. Fiyat için ara',
        visibility: 'Bu notu yalnızca kaydın sahibi ve yöneticiler görür; müşteri adayı asla görmez. Takip günü kaydın sahibine bir hatırlatma gider.',
        aiHint: 'Aktivite kaydı ve aşamadan üç öneri (bir AI kredisi kullanır). Birini seç, düzenle, kaydet.',
        aiEmpty: 'Henüz aktivite kaydı yok — önce bir aktivite ekle.',
      },
      // ROI ekranının gönüllü zaman alanları (#1895), temsilci diliyle.
      roi: {
        screen: {
          mentorHours: 'Fiyatlandırılacak ücretsiz temsilci saati',
          hints: {
            mentorHourValue: 'Gönüllü temsilci zamanını fiyatlar; gönüllülerle yürüyen bir program bedava görünmesin.',
            mentorHours: 'Kurumunuz gönüllü temsilci zamanını maliyet saymıyorsa 0 bırakın.',
          },
        },
        categories: {
          MENTOR_TIME: 'Temsilci zamanı',
        },
        steps: {
          mentorTimeCost: 'Faturalanmayan temsilci zamanı',
        },
        assumptions: {
          mentorHourValue: 'Bir temsilci saatinin değeri',
        },
      },
      seo: {
        homeTitle: '{product} — Pazarlama CRM',
        homeDescription: 'Müşterileri ilk temastan kapanışa kadar bir pazarlama hattında izleyen CRM.',
        applyAsMentorTitle: 'Başvur',
        applyAsMentorDescription: 'Programa katılmak için başvurun.',
        profileMentorTitle: '{name}',
        profileMenteeTitle: '{name}',
      },
      // Kişi = müşteri adayı (Lead); pipeline ilişkisi = fırsat (Deal). "Fırsat"
      // bilerek deal için ayrıldı, kişi listesi "Müşteri Adayları" oldu.
      goals: {
        visibilityPair: 'Satış temsilcisi ve müşteri adayı',
        visibilityProgram: 'Satış temsilcisi, müşteri adayı ve ekip',
        byMentor: 'Temsilci oluşturdu',
        byMentee: 'Müşteri adayı oluşturdu',
      },
      surveyResults: {
        byMentor: 'Satış temsilcisine göre',
        noRelationBreakdowns: 'Anonim yanıtlar dönem ya da sorumlu bilgisi taşımaz; bu yüzden bu ankette o kırılımlar yok.',
        role_MENTEE: 'Müşteri adayları',
        role_MENTOR: 'Satış temsilcileri',
        audience_BOTH: 'Müşteri adayları ve satış temsilcileri',
        createOnePerRole: 'Bu anket satış temsilcilerine soruyu farklı sözcüklerle soruyor, bu yüzden her rol için ayrı bir anket gerekir — diğer rol için ikincisini oluşturun.',
      },
      nav: {
        candidates: 'Müşteri Adayları',
        companyInquiries: 'Demo talepleri',
        myCompanies: 'Hesaplarım',
        mentorDirectory: 'Satış temsilcileri',
        mentors: 'Satış temsilcileri',
        mentorships: 'Fırsatlar',
        myMentees: 'Müşteri Adaylarım',
        inviteMentee: 'Müşteri adayı davet et',
        menteeActivity: 'Müşteri Adayı Etkinliği',
        mentorApplications: 'Satış Temsilcisi Başvuruları',
        agreements: 'Çalışma sözleşmesi',
      },
      invite: {
        subtitle: 'Satış temsilcilerini ve müşteri adaylarını davet et',
        connectMentor: 'Bu temsilciye ata (isteğe bağlı)',
        connectMentee: 'Bu müşteri adayını yeni temsilciye ver (isteğe bağlı)',
        connectHint: 'Burada seçilirse müşteri adayı, kayıt olduğu anda atanır — ayrıca bir adım gerekmez.',
        mentorTitle: 'Müşteri adayı davet et',
        mentorAutoAssign: 'Bağlantınla kaydolan kişi otomatik olarak senin müşteri adayın olur — ayrıca atama yapman gerekmez. Bağlantı tek kullanımlıktır ve 7 gün sonra geçersiz olur.',
      },
      notifications: {
        automationEmail: { mentorCheckIn: { cta: "Lead'lerimi aç" } },
        invitationEmail: {
          roles: { MENTOR: 'satış temsilcisi', MENTEE: 'müşteri adayı' },
        },
        slaEscalationEmail: {
          body: '{mentee} için aşama son tarihi {days} gün önce geçti ve aşama o günden beri ilerlemedi. Temsilci {mentor}, süre dolduğunda hatırlatıldı. Konu ele alındıysa SLA kuyruğunda onaylayın.',
        },
        events: {
          'interaction.logged': 'Yeni bir etkileşim kaydı eklendi.',
          'deadline.slaEscalated': '{menteeName} {days} gündür aşama son tarihini geçmiş durumda ve aşama ilerlemedi (temsilci: {mentorName}).',
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
          'outcome.needsMessage': '{name} bir sonuç aşamasına geldi. Ona bir mesaj yaz.',
          'duplicate.suspected': 'Yeni bir kayıt mevcut bir müşteri adayıyla aynı kişi olabilir: {name}.',
          'outcome.placedElsewhere': 'Yeni adımın için tebrikler! Buradaki yolculuğun tamamlandı olarak işaretlendi — ihtiyacın olduğunda kapı açık.',
          'goal.assigned': 'Fırsatına yeni bir hedef eklendi: "{title}".',
          'evaluation.added': 'Fırsatın hakkında yeni bir değerlendirme eklendi.',
          'mentorship_request.new': '{from} yeni bir iletişim talebi gönderdi.',
          'mentorship_request.newGeneric': 'Yeni bir iletişim talebi alındı.',
          'mentorship_request.approved': 'İletişim talebin onaylandı — muhatabına merhaba de!',
          'mentorship_request.rejected': 'İletişim talebin incelendi ancak şu an onaylanamadı.',
          'mentorship_request.rematch': '{from} farklı bir muhatap talep etti.',
          'mentorship_request.rematchGeneric': 'Bir müşteri adayı farklı bir muhatap talep etti.',
          'mentorship_request.rematchApproved': 'Yeni bir muhatabın var — önceki muhatabın artık seninle ilgilenmiyor.',
          'mentorship_request.rematchRejected': 'Farklı muhatap talebin incelendi. Mevcut muhatabın şimdilik seninle devam ediyor.',
          'mentorship_request.rematchMentorNotice': '{menteeName} ile fırsatın sona erdi — başka bir temsilciyle devam ediyor.',
          'application.received': '{name} müşteri adayın olarak kaydoldu.',
          'mentor_application.new': '{name} satış temsilcisi olmak için başvurdu.',
          'mentor_application.approved': 'Satış temsilcisi başvurun onaylandı — aramıza hoş geldin!',
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
        types: {
          mentorship_request: 'İletişim talebi',
          mentor_application: 'Satış temsilcisi başvurusu',
        },
        rematchRequestedEmail: {
          subject: 'Yeni muhatap talebi: {name}',
          heading: 'Yeni muhatap talebi',
          body: '{name} farklı bir muhatap talep etti. Siz karar verene kadar mevcut fırsatı aktif kalıyor.',
          privacy: 'Belirttiği gerekçe yönetici kuyruğunda duruyor ve mevcut temsilcisiyle paylaşılmıyor.',
        },
        rematchMentorEmail: {
          subject: '{name} ile fırsatınız sona erdi',
          heading: 'Bir fırsat sona erdi',
          body: '{name} ile fırsatınız sona erdi. Başka bir temsilciyle devam ediyor.',
          thanks: 'Ayırdığınız zaman ve emek için teşekkürler. Diğer müşteri adaylarınız bundan etkilenmiyor.',
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
      // The SSO role-mapping card (#2839), see the EN block.
      organizations: {
        ssoRoleMappingsHint: 'Claim\'i bu değeri içeren kullanıcı o rolü alır. En yüksek öncelik kazanır; eşitlikte düşük rol verilir. Eşleşme yoksa: müşteri adayı. Yönetici henüz eşlenemez.',
        ssoRoleNone: 'Henüz eşleme yok — her SSO kullanıcısı müşteri adayı olarak başlar.',
        ssoRoleSyncHint: 'Kapalı: mevcut kullanıcı rolünü korur. Açık: rolü her girişte eşlemeyi izler (yönetici için asla; hiçbir şeyle eşleşmeyen giriş bir şey değiştirmez).',
        relations: 'Fırsatlar',
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
            text: 'Merhaba {name}, {product} ile ilgilendiğiniz için teşekkürler! Bundan sonra muhatabınız benim — aklınıza takılan her şeyi bu sohbetten yazabilirsiniz.',
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
        pilotBody: 'Hesabı biz açıyoruz, hâlihazırdaki müşteri adaylarınızı sisteme bağlıyoruz ve istediğiniz gün verinizi siliyoruz. Ne tutacağı pazarlıkla değil ilan edilerek belirlendi — kimse size teklif vermeden rakamı kendiniz görebilirsiniz.',
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
        tagline: 'Müşteri adayları, firmalar ve anlaşmalar tek hatta — ilk temastan kapanışa.',
        becomeMentor: 'Satış temsilcisi ol',
      },
      auth: {
        signinSubtitle: '{product} hesabınıza giriş yapın',
        registerSubtitle: 'Davetinizle kaydolun',
        tokenHint: 'E-postanızdaki davet kodunu yapıştırın. Bu üründe hesaplar davetle açılır.',
        dataSharingTitle: 'Verileriniz nasıl paylaşılır',
        dataSharingBody: 'Rolünüze göre eklediğiniz bilgiler başkalarınca görülebilir: bir müşteri adayının bilgileri ve etkinlik geçmişi atanan temsilci ve yöneticiler tarafından görülür. Temsilciler yalnızca kendi müşteri adaylarını ve hesaplarını görür. Ayrıntılar için gizlilik bildirimine bakın.',
        wantMentor: 'Satış temsilcisi olmak ister misin?',
        becomeMentorPrompt: 'Bunun yerine satış temsilcisi mi olmak istiyorsun?',
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
          mentorCapacity: 'Müşteri adayı kapasiteni belirle',
        },
        guides: {
          profile: 'Bilgilerin ve yeteneklerin, bir satış temsilcisinin seninle konuşmadan önce okuduğu şeydir. Doldurulmuş bir profil doğru kişiye yönlendirilir; boş profil bekler. Şimdi ayıracağın beş dakika, ilk görüşmenin yazıyla cevaplanabilecek sorulara harcanmasını önler.',
          cv: 'CV ya da şirket profili, satış temsilcinin gerçekten okuduğu şeydir. Mükemmel olmasa da bugün gönderebileceğin sürümü yükle. İçinde yalnızca doğru ve doğrulanabilir bilgi olsun.',
          public: 'Herkese açık profil; telefon, e-posta ve adres içermeyen, dışarıdan bulunabilen bir sayfadır. İsteğe bağlıdır ve geri alınabilir: kapattığın anda sayfa da kaybolur.',
          bio: 'Ne yaptığını ve neyde yardımcı olabileceğini anlatan iki üç cümle yeter. Bir müşteri adayı her şeyden önce burayı okur; somut bir cümle bir unvandan daha çok işe yarar. Sesli söyleyeceğin gibi yaz.',
          interestsOrSkills: 'Yönlendirme buradan çalışır. Bildiğin ve keyif aldığın alanları yazman, karşına rastgele biri yerine sana uygun bir müşteri adayı çıkmasını sağlar. İki üç somut madde, on muğlak maddeden iyidir.',
          mentorCapacity: 'Kapasite, aynı anda kaç müşteri adayından sorumlu olmaya razı olduğundur ve ekip buna uyar: yönetici, sana birini atamadan önce bunu görür. Düşük ve dürüst belirle — iyi takip edilen bir aday, ihmal edilen üç adaydan değerlidir. İstediğin zaman artırabilirsin.',
          availability: 'Müsaitlik aralığı, kendi saat diliminde randevu almaya açık olduğun tekrar eden bir zaman penceresidir. Birkaç tane eklemen, müşteri adayının “salı olur mu?” e-posta zinciri olmadan saat seçmesini sağlar. Aralık bir penceredir, söz değil: sen kabul etmeden takvimine hiçbir şey girmez.',
          configurePipeline: 'Pipeline, her müşteri adayının ilk temastan kazanılan satışa kadar geçtiği aşamalar dizisidir. Hazır aşamaları olduğu gibi bırakmak gayet iyi bir karardır, bu yüzden bu adım isteğe bağlıdır. Ekibin gerçekten farklı sayıyorsa yeniden adlandır ya da sırala: her pano sütunu, rapor ve hizmet seviyesi bu aşamaların üzerine kuruludur.',
          documentRequirements: 'Birçok ekip evrak toplar: imzalı sözleşme, sipariş formu, uyum belgesi. Bunları burada tanımlamak, “herkesi e-postayla kovala” işini uygulamanın takip ettiği ve hatırlattığı bir listeye çevirir — aşama ve rol bazında. Yalnızca gerçekten ihtiyacın olanları ekle: her belge, bir müşteriden istediğin ek bir iştir.',
          evaluationTemplate: 'Değerlendirme çerçevesi, ekibinin bir müşteri adayını ya da fırsatı puanladığı birkaç ölçüttür. Bunları ilk değerlendirmeden önce yazmak, iki temsilcinin puanlarını karşılaştırılabilir kılan şeydir. Üç ile altı ölçüt fazlasıyla yeter; net bir fikrin yoksa hazır çerçeve iyi bir başlangıçtır.',
          inviteMentors: 'Önce satış temsilcilerini davet et: sorumlusu olmayan müşteri adayı bekler, adaysız temsilcinin yalnızca sakin bir haftası olur. Yüz yüze zaten “evet” demiş kişileri davet et — e-posta ricanın kendisi değil, kaydıdır. Girdiklerinde her birinden kapasitesini ve müsaitliğini girmesini iste.',
          inviteMentees: 'Elindeki müşteri adaylarını damla damla değil tek seferde ekle — pipeline ancak içinde insan varken sana bir şey söyler. Kimse bir başkasının verisini görmez.',
          addCompany: 'Hesaplar, satış yaptığın şirketlerdir; en az bir hesap olmadan pipeline’ın son aşamaları anlamsızdır. Zaten görüştüğün şirketleri, iletişim adresleriyle birlikte, ihtiyacın olmadan önce ekle. Bir hesabın ne aradığını kaydetmen, uygun müşteri adayının sonradan şansa hatırlanmak yerine kendiliğinden öne çıkmasını sağlar.',
          assignMentorship: 'Pipeline asıl burada başlar: bir temsilci, bir müşteri adayı ve o andan itibaren ortak bir görüşme, not ve aşama geçmişi. İki taraf da var olur olmaz ilk fırsatı oluştur — yanlış çıkan bir sorumluyu değiştirmek kolaydır. Her pano, rapor ve hatırlatma bu fırsatların üzerine kuruludur.',
          firstInteraction: 'Kaydedilen bir etkileşim — arama, e-posta, toplantı — ekibin ne konuşulduğunu hatırlama biçimidir. En önemlisi ilkidir: bir müşteri adayını devralacak meslektaşının okuduğu, hatırlatma işinin sessizliği ölçtüğü yerdir. Görüşmeden hemen sonra kaydet. Bu adım isteğe bağlıdır: kurulumun parçası değil, bir dönüm noktasıdır.',
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
        selfMatchLimitHint: 'Seni kaç müşteri adayı kendisi seçebilir (dizinden talep ya da bağlantın). Boş = kapasitenle aynı. Yöneticiler seni kapasitene kadar yine de atayabilir. Kişisel bir tercih, asla bir plan sınırı değil.',
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
      // Rapor kaydı (#1903): mentorluk raporları `mentorship` yeteneği olmayan
      // kiracıya kapalı, ama sütun etiketleri ortak.
      reports: {
        mentorWorkload: { title: 'Temsilci iş yükü', description: 'Temsilci başına aktif fırsatlar ve kaçının son aşamaya ulaştığı.' },
        weeklyReportCompliance: { description: 'Bu dönem kişi başına beklenen, teslim edilen, eksik ve geç haftalık raporlar.' },
        col: { mentor: 'Temsilci', intern: 'Kişi' },
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
      panel: {
        sales: 'Satış',
        mentor: 'Temsilci Portalı',
        mentee: 'Müşteri Adayı Portalı',
      },
      sales: {
        dashboard: { title: 'Satış pipeline\'ın', subtitle: 'Kendi müşteri adayların ve hesapların, bugün seni bekleyenler.' },
        stats: { open: 'Açık müşteri adayları', accounts: 'Hesaplar' },
        records: {
          title: 'Müşteri adaylarım',
          empty: 'Panonda henüz müşteri adayı yok. “Yeni lead” ile kendin oluştur ya da bir yönetici — veya varsayılan sahip ayarı — sana atasın.',
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
        dashSubtitle: 'Müşteri adaylarına ve etkileşimlerine genel bakış',
        activeMentees: 'Aktif Müşteri Adayı',
        myMentees: 'Müşteri Adaylarım',
        currentRelationships: 'Mevcut aktif fırsatlar',
        noActiveMentees: 'Atanmış aktif müşteri adayı yok',
        exampleLogNote: 'Mevcut teklifteki ilerleme ve fırsatın sonraki adımları konuşuldu.',
        goToMenteeToLog: 'Etkileşim kaydetmek için bir müşteri adayının detay sayfasına git',
        interactionSearchPlaceholder: 'Konu, not veya müşteri adayı ara...',
        menteeDormantMatchOne: 'Bu filtreyle eşleşen 1 pasif müşteri adayı var ve gizli kalıyor.',
        menteeDormantMatchMany: 'Bu filtreyle eşleşen {n} pasif müşteri adayı var ve gizli kalıyor.',
        menteesSubtitle: 'Tüm fırsatların',
        noMenteesAssigned: 'Henüz atanmış müşteri adayı yok',
        noMenteesHint: 'Başlamak için ilk müşteri adayını ekle veya başvuru linkini paylaş.',
        interactionLogsSubtitle: 'Müşteri adaylarınla tüm etkileşim kayıtların',
        backToMentees: 'Müşteri adaylarına dön',
        addMentee: 'Müşteri Adayı Ekle',
        newMentee: 'Yeni Müşteri Adayı',
        menteeCreated: 'Müşteri adayı oluşturuldu',
        setPwLinkHint: 'Müşteri adayına parolasını belirleyip hesabını aktifleştirmesi için bir bağlantı e-postaladık. Ulaşmazsa bu bağlantıyı doğrudan onunla paylaşabilirsin:',
      },
      emptyStates: {
        board: {
          adminBody: 'Her fırsat burada, ulaştığı aşamada bir kart olarak görünür. İlk müşteri adaylarını ekle; bir temsilci sahiplendiği anda kartları burada belirir.',
          mentorBody: 'Sana atanan müşteri adayları burada kart olarak görünür.',
        },
        companies: {
          adminBody: 'Şirketler sattığın müşteri hesaplarıdır: bir şirket eklediğinde ona ihtiyaçlarını, iletişim kişilerini ve açık fırsatlarını bağlayabilirsin.',
        },
        candidates: {
          adminBody: 'Kaydolan ya da daveti kabul eden herkes; temsilcisi, hesabı ve aşamasıyla birlikte bu listeye düşer. İlk daveti gönder, liste kendiliğinden dolsun.',
        },
        requisitions: {
          companyBody: 'Bir talep, temsilcilere hangi pozisyon için işe aldığını, kaç kişiye ihtiyacın olduğunu ve hangi yetkinliklerin önemli olduğunu anlatır. Birini oluştur ki sana uygun kişiler önerilebilsin.',
        },
        interviewRequests: {
          mentorBody: 'Bir hesap müşteri adaylarından biriyle görüşmek istediğinde talep, önerilen saatlerle birlikte burada belirir; görüşmeyi buradan ayarlarsın.',
        },
        weeklyReports: {
          menteeBody: 'Haftalık rapor; ne yaptığını, ne kadar sürdüğünü ve seni neyin engellediğini anlatan kısa bir nottur. İlkini yukarıdaki formda yaz ki muhatabın yorum yapabilsin.',
          mentorBody: 'Müşteri adayın rapor gönderdikçe en yeniden başlayarak burada listelenir; onaylayabilir ya da değişiklik isteyebilirsin. Henüz gönderilmiş bir rapor yok.',
        },
        documents: {
          mentorBody: 'Müşteri adayın henüz bir şey yüklemedi. Sözleşmeleri, sipariş formları ve sertifikaları geldikçe sürüm geçmişiyle birlikte burada görünecek.',
          menteeBody: 'Sözleşmelerin, sipariş formların ve sertifikaların burada durur. İlkini aşağıdan yükle; muhatabın anında görebilsin.',
        },
        portalGoals: {
          title: 'Henüz muhatap atanmadı',
          menteeBody: 'Hedefler, değerlendirmeler ve haftalık raporlar bir fırsata bağlıdır; bir yönetici sana muhatap atadığında açılırlar. Eksiksiz bir profil bunu hızlandırır.',
        },
        todos: {
          body: 'Bu liste; muhatabının sana verdiklerini, projelerinin ihtiyaç duyduklarını ve kendi eklediklerini bir arada tutar. İlk satırı yukarıdaki kutuya yaz.',
        },
      },
      landing: {
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
        pipelineNote: 'Her aday kapanmaz: kaybedilen anlaşmalar da kaydedilir, huni size doğruyu söyler.',
        stageApply: 'Yeni aday',
        stageInterview: 'İletişime geçildi',
        stageInternship: 'Teklif gönderildi',
        stageHired: 'Kazanıldı',
        ctaTitle: 'Her anlaşmayı tek yerde görmeye hazır mısınız?',
        ctaSubtitle: 'Hattınızı dakikalar içinde kurun — ekibiniz davetle giriş yapar.',
        ctaMentee: 'Giriş yap',
        trans5T: 'Mekanizma olarak onay',
        trans5D: 'Müşteri verisi ekibiniz dışında kimseye gösterilmez; her onay sürümüyle kaydedilir ve her an geri alınabilir. E-posta ve telefon hiçbir herkese açık sayfada görünmez.',
        badge: 'Pazarlama CRM · Adayları takip et · Anlaşmaları kapat',
        heroTitle: 'Her aday, her görüşme, her anlaşma —',
        heroAccent: 'tek bir hatta.',
        heroSubtitle: 'Müşterilerini ilk temastan kapanışa kadar takip et. Her anlaşmanın nerede olduğunu, en son kimin dokunduğunu ve sıradaki adımı — tabloda parça parça aramak yerine — tek bakışta gör.',
        featuresTitle: 'Kapatmak için ekibinin ihtiyacı olan her şey',
        becomeMentor: 'Satış temsilcisi olmak ister misin?',
        fMentorT: 'Temsilci self-service',
        fMentorD: 'Temsilciler kendi müşteri adaylarını ekler; toplantı, geri bildirim, e-posta, arama ve WhatsApp görüşmelerini loglar; özel notlar tutar ve panosunda ilgi bekleyenler kuyruğunu görür — admin de hepsini yapabilir.',
        fGrowthD: 'Görev listeli ve ilerleme takipli fırsat projeleri, kişisel hedefler, çift yönlü yapılandırılmış ara/final değerlendirmeleri ve müşteri adayı–temsilci arası yerleşik Soru & Cevap.',
        roleMentor: 'Satış temsilcisi',
        roleMentee: 'Müşteri adayı',
        heroModel: 'Kullanıcı başına tek fiyat — gizli ek ücret yok.',
        freeCoreBody: 'Mesajlar, görüşmeler, hedefler, değerlendirmeler ve pipeline’ın tamamı her pakete dahildir — kullanıcı başına faturalanır, gizli ek ücret yok.',
        liveMentors: '{n} temsilci',
        liveWaiting: 'temsilci bekleyen {n} müşteri adayı',
        pickMenteeT: 'Bir çözüm arıyorum',
        pickCompanyD: 'Müşteri adayını, onunla aylarca çalışmış temsilcisinden tanı.',
        audCompanyTitle: 'Müşteri adayını CV’sinden değil, onunla aylarca çalışan satış temsilcisinden tanıyın.',
        audCompanySubtitle: 'Müşteri adaylarınızı ilk günden izleyin, kararı iki görüşmeye değil aylara yayılmış yazılı bir kayda bakarak verin. Pilot dönemdeyiz: hesabı biz açıyoruz, ücret almıyoruz, sözleşme yok.',
        audCompany1T: 'Müşteri adayınız nerede, ne durumda?',
        audCompany1D: 'Hesabınıza bağlı her müşteri adayının hangi aşamada olduğunu, satış temsilcisinin kim olduğunu ve sürecin hunisini tek ekranda görürsünüz. Görüşme notlarını ve hedefleri temsilci tutar; siz durumu ve temsilcinin dönemsel değerlendirmesini okursunuz. Yazma yetkisi sizde değil — kaydı tutan tarafın tarafsız kalması için.',
        audCompany2D: 'Süreç tek bir hatta izlenir: fırsat başlayacak → fırsat devam ediyor → kapanmaya hazır → kazanıldı. Müşteri adayını bir görüşme performansıyla değil, aylarca süren gerçek işle tanırsınız.',
        audCompany3D: 'Müşteri adayının zaten bir satış temsilcisi var: hedeflerini koyan, düzenli görüşen, ilerlemesini yazan, dönemsel değerlendirme üreten biri.',
        audCompany4T: 'Satış temsilcisi imzalı müşteri adayı karnesi.',
        audCompany4D: 'Hesabınızla fırsatı başlayan her müşteri adayı için satış temsilcisi iki kez — ara ve final — dört başlıkta puan ve yazılı yorum girer: teknik, iletişim, güvenilirlik, gelişim. Yanında adayın tamamladığı gerçek proje görevleri durur. Karne, birlikte geçen zamanın ürünüdür: havuz tanışma yeridir, karar yeri değil. Değerlendirmelerin hesaba açılması premium bir yetkiye bağlı ve bugün elle açılıyor.',
        stories: {
          roles: {
            mentor: 'Satış temsilcisi',
            mentee: 'Müşteri adayı',
          },
        },
        faqMentee5A: 'Müşteri adayı hiçbir şey ödemez. Seninle ilgilenen ekip kullanıcı başına öder — onlara verini değil, yazılımı satıyoruz.',
        faqCompany1A: 'Hesabınızı biz açıp mevcut müşteri adaylarınızı sisteme bağlıyoruz; panelde en az bir gerçek müşteri adayı olmadan size link göndermiyoruz.',
        ctaMentor: 'Satış temsilcisi olarak başvur',
      },
      featureCatalog: {
        title: '{product} neler yapabilir',
        subtitle: 'Tüm özellik kataloğu — ilk temastan kapanan anlaşmaya, tüm ekibiniz için.',
        categories: { collaboration: 'Birlikte çalışma' },
        items: {
          messaging: { d: 'Fırsat başına thread’ler, ekler ve cevaplanabilir e-posta yansıtması olan tek gelen kutusu — bildirimi kendi e-posta uygulamanızdan yanıtlayın, cevabınız thread’e düşer. Mesajlar gelen kutusu açıkken anında görünür; izin verirseniz uygulama kapalıyken de cihazınıza bildirim gelir. Yarım kalan yanıt gönderilene kadar sohbet başına saklanır ve karşı taraf yazarken bunu görürsünüz. Sürekli verdiğiniz yanıtlar ortak bir hazır yanıt havuzunda durur — İngilizce, Türkçe ve Almanca bir kez yazılır, kendi dilinizde tek tıkla eklenir.' },
          videoCalls: { d: 'Bir müşteri adayı, firma ekibi veya sohbetle tek tıkla görüşme başlat; görüşme, kaydın yanındaki yan panelde kendi Jitsi kiracımızda açılır — hesap yok, kurulum yok, süre sınırı yok. Görüşme ücretsiz herkese açık odaya düşmek zorunda kalırsa panel bunu kimse katılmadan önce söyler ve konuşmayı sürdürmenin tek tıklık yolunu verir. Link davet edilen herkese e-postayla gider ve her tarayıcıda çalışır.' },
          externalGuests: { d: 'Bir toplantı her zaman yalnızca kendi ekibinizden ibaret değildir. Planlayıcıya herhangi bir e-posta adresi yaz; o kişi aynı odaya, aynı Evet/Hayır butonlarıyla davet edilsin — hesap yok, kayıt yok, kendi takvimi için .ics var. Kimin kabul ettiğini görürsün ve yanlış adrese giden bir davet geri alınabilir; bağlantısı da o anda çalışmayı bırakır.' },
          ownWorkspace: { t: 'Her satış temsilcisine kendi çalışma alanı', d: 'Her temsilci kendi portföyüne giriş yapar: müşteri adayları ve hesapları, vadesi gelen takipler ve deneme bitişleri, kendi panosu — ve az önce yaptığı görüşmeyi hemen kaydetme imkânı. Başka bir temsilcinin ya da başka bir kuruluşun fırsatları gizli bir sekmede durmaz; o sayfada hiç yoktur.' },
          inviteLinks: { d: 'Adresini bilmediğin birini davet et: alanı boş bırak, elden verebileceğin tek kullanımlık ve 7 gün geçerli bir bağlantı üretilsin. Bağlantıyla kaydolan kişi doğrudan gönderene bağlanır ve özel bir not, birbirine benzeyen bağlantıları ayırt edilebilir kılar.' },
          pricing: {
            d: 'Fiyat listesi teklifte değil, sitede: paket bantları, yönetici koltukları, aşım ücreti ve tüm ek paketler. Tek ölçü birimi aktif fırsat olduğu için satış temsilcileri ve müşteri adayları yapısal olarak faturalanamaz; sayfa hiçbir pakette neyin ölçülmediğini de açıkça yazar.',
          },
          rematch: {
            t: 'Farklı bir muhatap iste',
            d: 'Temsilcisiyle işler yürümeyen bir müşteri adayı, sebep kategorisi ve isteğe bağlı bir notla ekipten farklı bir muhatap isteyebilir. Yönetici karar verene kadar mevcut fırsat tamamen canlı kalır, değişim tek adımda yapılır — kimse muhatapsız kalmaz — ve ayrılan temsilciye yalnızca fırsatın devredildiği bildirilir, hakkında yazılanlar asla gösterilmez.',
          },
          activityReport: {
            d: 'Satış temsilcileri ve adminler için rıza temelli müşteri adayı aktivite özetleri: girişler, sitede geçen süre, gezilen sayfalar ve tamamlanan görevler.',
          },
          menteeOwnProject: {
            d: 'Bir müşteri adayı yalnızca projelere atanmaz — kendisi de proje başlatabilir. Portaldan açılan projenin sahibi onu açan kişidir: tüm alanları düzenler, yapılacaklarını yönetir. Kendi projesi gizli başlar; yani bir yönetici birini ekleyene ya da projeyi vitrine çıkarana kadar tek kişilik bir ekiptir — vitrindeyken sahibi katılma isteklerini onaylayarak ekibini büyütür.',
          },
          menteeInsights: {
            d: 'Bir müşteri adayının satış temsilcisinin ve ekibin okuduğu etkinlik özetini artık kendisi de portaldaki kendi sayfasında okuyor: hedefler, toplantılar, etkileşimler, aşama değişimleri ve mesajlar; etkinlik takibi açıkken sitede geçen süre ve gezilen sayfalar. Başkalarıyla kıyaslama yok, puan yok ve asla ücretli bir özellik değil.',
          },
          publicProfiles: {
            d: 'Müşteri adayları ve satış temsilcileri isterlerse kişisel veri içermeyen herkese açık bir profil sayfası açabilir — linki LinkedIn, WhatsApp veya Slack’te paylaşıldığında isim, rol, konum ve öne çıkan becerileri gösteren markalı bir karta dönüşür.',
          },
          interviewRequests: {
            d: 'Hesaplar müşteri adaylarını iş talebi bazında kısa listeye alıp mülakat ister; ekip veya atanmış satış temsilcisi her talebi planlamadan önce değerlendirir.',
          },
          aiPackage: {
            d: 'Müşteri adaylarına CV geri bildirimi ve mülakat hazırlığı, satış temsilcilerine etkileşim özeti, AI destekli atama ve yöneticilere değerlendirme yorumlarıyla haftalık rapor engellerindeki temalar — her tema arkasındaki satırlara bağlı. Hepsi rıza ve kota kapılı.',
          },
          matchingRules: {
            d: 'İyi bir satış temsilcisi atamasını neyin belirlediğine — beceri, dil, alan, şehir, saat dilimi, kapasite — ve her birinin ne kadar önemli olduğuna karar ver; pazarlıksız kuralları işaretle, kimse kendi yöneticisine ya da eski muhatabına atanmasın. Deneme çalıştırması bağlamadan önce kimin kime atanacağını gösterir ve fazla sıkı kuralı adıyla söyler. Her skor kendini kural kural açıklar.',
          },
          matchQuality: {
            d: 'Platformun yaptığı her satış temsilcisi önerisi, listede kaçıncı sırada gösterildiğiyle birlikte kaydediliyor; tek tıkla kapatma ise nedenini soruyor — yanlış alan, kapasite yok, dil, zaten atanmış. Analiz sayfası da her ekip sorumlusunun bir gün sorduğu soruyu yanıtlıyor: öneriler gerçekte ne sıklıkla kabul ediliyor ve ilk sıradaki temsilci cidden seçiliyor mu? Öneri yine sadece öneri kalıyor — kararı her zaman bir insan veriyor.',
          },
          selfServe: {
            t: 'Self-servis müşteri adayı başvurusu',
            d: 'Müşteri adayları kendileri kaydolur, onboarding’i tamamlar ve muhatap talep eder; adminler kuyruktan onaylar.',
          },
          outcomeComms: {
            d: 'Bir fırsat bittiğinde portal, durumu sessizce değiştirmek yerine nerede olunduğunu ve bundan sonra ne yapılabileceğini yazar; temsilciye boş sayfa değil, düzenlemeye hazır bir mesaj verilir. Otomatik gönderim varsayılan kapalı — giden her red mesajını önce bir insan okur. Aradığını başka yerde bulan müşteri adayı ise başarısızlık sayılmaz, kendi metniyle karşılanır.',
          },
          joinRequests: {
            d: 'Açık projeler, sahibinin tek tıkla onayladığı katılma talepleri alır; müşteri adayı, satış temsilcisi ve admin dahil herkesin, gelen kişiyi kimin getirdiğini kaydeden kişisel davet linki olur.',
          },
          todos: {
            d: 'Bir kişinin yapması gereken her şey tek yerde: satış temsilcisinin verdikleri, projelerinden gelenler, üstlenebileceği sahipsiz proje hedefleri ve kendine yazdıkları — bitenler silinmez, arşivlenir. Ortak ve çok dilli listeden gelen madde ona bağlı kalır: metni bir kez düzenlemek, o maddeyi alan herkeste kendi dilinde güncellenmesini sağlar. Her maddeye bitiş tarihi verilebilir: tarihi en yakın olan önce, tarihsizler sonda görünür, gecikenler yalnızca renkle değil “Gecikti” yazısıyla işaretlenir ve temsilci ya da yönetici sorumlu olduğu herkesin listesini tek yerde okuyabilir.',
          },
          dualRole: {
            d: 'Bir satış temsilcisi aynı zamanda müşteri adayı olabilir. Başkalarıyla ilgilenen kişinin kendisinin de bir muhataba ihtiyacı olabilir — bir temsilciye kendi temsilcisi atandığında, satış sayfalarının yanında müşteri adayı portalı da açılır ve kenar çubuğundaki görünüm düğmesiyle ikisi arasında geçilir. Yöneticiler bir fırsatın iki tarafına da herkesi koyabilir; kimse kendisiyle eşleştirilemez.',
          },
          weeklyReports: {
            t: 'Haftalık müşteri adayı raporları',
            d: 'Müşteri adayları haftalık rapor yazar, taslaklarını saklar ve günlüklerini yazdırır; temsilciler her gönderimi onaylar veya değişiklik ister. Eksik raporlar temsilcinin dikkat kuyruğuna ve haftalık hatırlatmaya yansır; koordinatörler dönem boyu uyum matrisi, tek tıkla hatırlatma, XLSX dışa aktarma ve müşteri adayı başına yazdırılabilir rapor defteri alır.',
          },
          newsletter: {
            d: 'CV ve mülakat tavsiyelerini emojili, kısa sayılar hâlinde ulaştırır; İngilizce, Türkçe ve Almanca bir kez yazılır, her okuyucuya kendi dilinde gider. Elle ya da haftalık, iki haftalık, aylık programla gönderilir; satış temsilcileri aynı sayıda koçluk bakışını da görür, her gönderim kayda geçer ve tek dokunuşla abonelik bırakılır.',
          },
          mentorSelfApply: {
            t: 'Self-servis satış temsilcisi başvurusu',
            d: 'Herkes hesap açmadan satış temsilcisi olmak için başvurabilir; adminler kuyruktan inceler, incelemeye alır, onaylar veya reddeder; onay, temsilcinin hesabını otomatik olarak oluşturur veya yükseltir.',
          },
          offers: {
            d: 'Bir müşteri adayının fırsat kartından üç adımda teklif oluşturun, önizleyin ve gönderin; müşteri adayı portalından kabul veya (nedeniyle) reddeder, kararı kalıcı olarak görünür kalır, süresi geçen teklifler kendiliğinden süresi doldu olur — her adım kaydedilir ve bildirilir. Yönetici teklif listesi hangi tekliflerin hâlâ beklediğini, hangilerinin bu hafta dolduğunu ve hangilerinin neden reddedildiğini yanıtlar.',
          },
        },
      },
      pricing: {
        heroBadge: '{product} fiyatları',
        heroTitle: 'Kullanıcı başına tek fiyat, sürpriz yok',
        heroSubtitle: 'Satış ekipleri için kullanıcı başına faturalanan paketler. Gizli ek ücret yok — kendiniz çalıştırmak isterseniz kod açık kaynak.',
        discountsTitle: 'Şimdiden doğru olanlar',
        freeTitle: 'Kullanıcı başına faturalama, sürpriz yok',
        freeBody: 'Paketler satış ekibindeki kullanıcı başına faturalanır. Gizli ek ücret yok — her paket ve sınırları bu sayfada listelenir.',
        neverMetered: {
          messaging: 'Satış temsilcisi ve müşteri adayı arasındaki mesajlar',
          portal: 'Müşteri adayı portalı',
        },
        planDesc: {
          employer_free: 'Bir marka sayfası ve temsilci onaylı kısa listeye yanıt verme.',
        },
        meteringCounted: 'Sayılır: takvim ayı içinde herhangi bir etkinliği kayda geçmiş, ACTIVE durumdaki bir fırsat.',
        meteringNeverCounted: 'Asla sayılmaz: satış temsilcileri ve müşteri adayları. Onlar ölçebileceğimiz bir birim değil.',
        employerSubtitle: 'Ayrı bir cüzdan, farklı bir alıcı. Buradaki hiçbir şey bir ekibin ödediğini değiştirmez, bir hesabın ödediği hiçbir şey de müşteri adayı tarafına geçmez.',
        faq1Q: 'Satış temsilcisi ya da müşteri adayı hiç ödeme yapar mı?',
        faq1A: 'Hayır — ve bu sessizce değiştirebileceğimiz bir politika değil, çünkü onlar ölçü birimi değil. Satılacak bir temsilci koltuğu ya da müşteri adayı koltuğu yok.',
        faq2A: 'ACTIVE durumda, bir satış temsilcisine atanmış bir müşteri adayı ve o takvim ayında en az bir kayıtlı etkinlik. Duraklattığınız bir fırsat sayılmaz; tamamlanan bir fırsat, tamamlandığı ay saymayı bırakır.',
        ctaMenteeT: 'Satış temsilcisi istiyorum',
        ctaMentorT: 'Müşteri adaylarıyla çalışmak istiyorum',
        ctaMentorA: 'Satış temsilcisi olarak başvur',
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
      slaQueue: {
        colOwner: 'Temsilci',
        levelMentor: 'Temsilciye bildirildi',
        complianceDefinition: 'Dönem içinde, hizmet seviyesi tanımlı bir aşamadan yapılan geçişlerin, o süre dolmadan yapılanlarının oranı — müşteri adayının aşamaya girdiği andan itibaren, takvim günüyle ve bugün tanımlı hizmet seviyelerine göre ölçülür. Yeniden etkileşim havuzundaki müşteri adayları ve saati durmuş aşamalar sayılmaz.',
      },
      stageSla: {
        escalateHint: 'Üst kademe: bir aşama son tarihi geçtikten bu kadar gün sonra hâlâ gecikmişse kurumun yöneticilerine de — bir kez — haber verilir. Boş bırakırsan, eskisi gibi yalnızca temsilciye hatırlatılır.',
        scopeMentor: 'Temsilci',
        allMentors: 'Tüm temsilciler',
        overrideHint: 'Bir istisna düzenliyorsun. Bu kayıtlar için kurumun sayısının önüne geçer — önce temsilci ve dönem birlikte, sonra temsilci, sonra dönem, en son kurum. Devralmak için aşamayı boş bırak. Boş bırakılan üst kademe de devralınır; pano limitleri kurum genelinde kalır.',
        sourceMentor: 'bu temsilci',
        sourceMentorCohort: 'bu dönemdeki bu temsilci',
        subtitle: 'Bir aşamada en fazla ne kadar beklenebileceği; aşıldığında temsilciye uyarı gider. Boş bıraktığın aşamanın kuralı yoktur — hiç kural tanımlamayan bir kurum eskisi gibi çalışmaya devam eder.',
      },
      share: { title: '{product} ile paylaşıldı' },
      publicProfile: {
        poweredBy: '{product}',
        mentor: 'Satış temsilcisi',
        activeMentees: 'Aktif müşteri adayı sayısı',
        evaluationTitle: 'Temsilci değerlendirmesi',
        evaluationByMentor: 'temsilci',
      },
      imprint: { intro: 'Bu {product} kurulumunu kim işletiyor ve kendisine nasıl ulaşılır.' },
      privacy: {
        intro: 'Müşteri adaylarını, hesapları ve fırsatları yönetmek için sağladığın bilgileri saklarız. Bu bildirim; neyi, neden işlediğimizi, kimin görebileceğini, ne kadar sakladığımızı ve haklarını açıklar (GDPR Md. 13–15).',
        controllerBody: 'Burada işlenen kişisel verilerin sorumlusu, bu {product} kurulumunu işleten {operator}. Posta adresi ve diğer iletişim bilgileri künyede yayınlanıyor.',
        controllerUnset: 'Veri sorumlusu, bu {product} kurulumunu işleten taraftır; bilgileri bu dağıtımın künyesinde yayınlanır.',
        purposesBody: 'Platformu işletmek için: müşteri adaylarını ve hesapları satış hattında takip etme, satış temsilcilerine atama, etkileşimleri kaydetme, planlama ve iletişim. Bir satış temsilcisi size yazdığı e-postada bu CRM’in adresini gizli kopyaya (BCC) eklerse ya da sizin yanıtınızı bu adrese yönlendirirse, e-postanın tarihi, konusu ve ilgili e-posta adresleri hesabınızda bir etkileşim olarak kaydedilir; içerik ve ekler saklanmaz.',
        legalBasisBody: 'İşleme, rızana (Md. 6(1)(a)) ve satış sürecini yürütmenin meşru menfaatine (Md. 6(1)(f)) dayanır. İsteğe bağlı işlemeler her zaman ayrı bir rıza gerektirir.',
        recipientsBody: 'Rolüne göre: bir müşteri adayının kaydı ve etkileşim geçmişi, onu üstlenen satış temsilcisi ve yöneticiler tarafından görülür. Temsilciler yalnızca kendi müşteri adaylarını ve hesaplarını görür. Verini asla satmayız. Herkese açık ana sayfada, yalnızca pazarlama çerezlerini kabul edersen canlı sohbet tawk.to üzerinden yüklenir; IP adresini ve sohbete yazdıklarını alır. Kabul etmezsen ya da sohbete dokunmazsan onlara hiçbir şey gitmez.',
        use: 'Verilerin yalnızca platformu işletmek için kullanılır — satış hattı takibi ve iletişim.',
        aiBody: 'Bir özellik bir yapay zekâ sağlayıcısına metin gönderebilir: bir yönetici bir müşteri adayını bir satış temsilcisine atarken, temsilci önerisi müşteri adayının yetkinliklerini, pozisyonunu ve ilgi alanlarını, en fazla beş temsilcinin de yetkinliklerini, ilgi alanlarını ve mevcut yüklerini gönderir; iki tarafta da ad veya kimlik yoktur. Kimseyi tanımlayan hiçbir şey gönderilmediği için rıza istemez; bir yönetici onu tüm kurum için kapatabilir. Ne gönderilen ne de üretilen metin saklanır. Neyi gönderdiği, neyi bilerek göndermediği ve sağlayıcının kim olduğu yapay zekâ sayfasında tek tek yazılıdır.',
      },
      terms: {
        intro: '{product} kullanarak bu şartları kabul etmiş olursun.',
        use: 'Platformu yalnızca yasal müşteri ve satış yönetimi için kullan.',
      },
      trust: {
        operatorUnset: 'Bu kurulum henüz bir işletici yayımlamadı. {product} açık kaynaktır ve her dağıtım kendi işleticisini kendi künyesinde belirtir.',
        posture: {
          dataD: 'Verin satılmaz. Kod tabanında ödeme sağlayıcısı, reklam ağı veya veri simsarı yok.',
          crmD: 'Analitik ve canlı sohbet yalnızca herkese açık kabuktan yüklenir, hiçbir zaman uygulamanın kendisinden değil. Oturum açılmış bir sayfa görüntülemesi bir müşteri adayının adını sağlayıcıya taşırdı; bu yüzden mümkün değil.',
        },
        residencySelfHost: '{product} AGPL-3.0-or-later lisanslıdır. Kendi kurulumunuzu, kendi altyapınızda, kendi yargı alanınızda, kimseden izin almadan ve kimseye ödeme yapmadan çalıştırabilirsiniz. Bu projenin sunabileceği en güçlü veri yerleşimi güvencesi budur, çünkü bizi sorunun dışına çıkarır. İkili lisanslama, hak sahibi Mehmet Erşahin’den alınabilir — bir şirket değil, gerçek bir kişi.',
        freeNote: 'Bu sayfadaki hiçbir şey ücretli bir eklenti değil.',
      },
      accessibility: {
        intro: '{product} uygulamasını bir satış temsilcisinin, bir yöneticinin ya da bir sistem yöneticisinin klavyeyle, ekran okuyucuyla, büyüteçle ya da kol mesafesindeki bir telefonla kullanabileceği şekilde geliştiriyoruz. Bu beyan hangi standardı ölçüt aldığımızı, bunu nasıl denetlediğimizi, henüz neyin çalışmadığını ve bir engelle karşılaştığınızda kime yazacağınızı anlatır.',
        scopeBody: 'Bu kurulumdan sunulan {product} web uygulaması: herkese açık sayfalar, giriş akışı ve arkasındaki temsilci ve yönetici alanları. Kullanıcıların yüklediği dosyaları, başkasının posta istemcisinde görüntülenen e-postaları ve aşağıda adı geçen üçüncü taraf hizmetleri kapsamaz.',
        evidence: {
          dragAlternative: 'Pipeline panosu sürükle-bırak olmadan da kullanılabiliyor: her kartta, fırsatı yalnızca klavyeyle taşıyan bir aşama seçici var.',
        },
        limitations: {
          thinFixture: 'Otomatik tarama, ortak kod tabanını varsayılan ürün yapılandırmasıyla çalıştırıyor; dolayısıyla yalnızca {product} uygulamasının gösterdiği ekranlar ve metinler henüz otomatik denetimin kapsamında değil.',
        },
      },
      ai: {
        intro: 'Bu üründe bir özellik, üçüncü bir tarafın çalıştırdığı bir dil modeline metin gönderir. Bu sayfa onu adıyla anar; sunucumuzdan tam olarak neyin çıktığını ve neyin bilerek çıkmadığını söyler; bir denetçinin yapmış olmamızı bekleyeceği bir şeyi henüz yapmadıysak onu da söyler.',
        tasks: [
          {
            name: 'Temsilci önerisi',
            audience: 'Yöneticiler için, bir müşteri adayını bir satış temsilcisine atarken.',
            sent: 'Bir müşteri adayının yetkinlikleri, pozisyonu ve ilgi alanları ile en fazla beş temsilci; temsilciler A–E harfleriyle anonim olarak, yalnızca yetkinlik, ilgi alanı ve mevcut yükleriyle.',
            withheld: 'Her iki taraftaki tüm adlar, e-posta adresleri ve kimlikler. Harfler, yanıt geldikten sonra kendi sunucumuzda gerçek kişilere eşlenir.',
            consent: 'İstenmez, çünkü kimseyi tanımlayan hiçbir şey gönderilmez.',
          },
        ],
        consentBody: 'Yukarıdaki özellik kimseyi tanımlayan hiçbir şey göndermez, bu yüzden kimseden rıza istemez. Üründe başka hiçbir şey ona bağlı değildir — hiçbir temel akış yapay zekâya ihtiyaç duymaz ve yapay zekâ kapalıyken elindeki her özellik çalışmaya devam eder.',
        humanBody: 'Hiçbir model bir hat aşaması belirlemez, kimseyi kabul veya reddetmez, teklif vermez, hesap durumu değiştirmez. Temsilci önerisi önce düz bir kuralla sıralanır — ortak yetkinlikler, sonra yeri olan — ve model yalnızca bu kısa listeyi yeniden sıralayıp birer cümlelik gerekçe ekler; okuyup karar veren yöneticidir.',
        retentionBody: 'Ne gönderilen ne de dönen metin saklanır. Üretilen metin tarayıcında gösterilir ve sayfayı yenilediğinde kaybolur. Her çağrı için tek bir ölçüm satırı tutarız: hangi özellik, ne zaman, hangi hesap. İstem, çıktı ya da bunlardan bir alıntı yok — böylece aylık limit, kimsenin verisi saklanmadan sayılabilir.',
        notYet: [
          'Bu uygulama için SOC 2 veya ISO 27001 sertifikamız yok.',
          'Yapay zekâ sağlayıcısıyla ayrı bir veri işleme sözleşmesi ya da sıfır saklama anlaşması imzalamış değiliz; yayımlanmış ticari koşullarını kullanıyoruz.',
          'Bir işleme bölgesi taahhüt edemiyoruz — istekler sağlayıcının hizmet verdiği yerde işlenir.',
          'Temsilci önerisinin ne kadar isabetli ya da ne kadar yanlı olduğunu ölçen bir değerlendirme yayımlamadık.',
        ],
      },
      programTemplates: {
        blockers: {
          strandedRelations: 'Bazı müşteri adayları bu şablonda bulunmayan aşamalarda duruyor. Önce onları taşıyın veya tamamlayın — şimdi uygularsanız artık var olmayan bir aşamada kalırlar.',
        },
        items: {
          canonical_pipeline: {
            name: 'Standart yerleştirme hattı',
          },
          graduate_internship: {
            name: 'Mezun programı',
            desc: 'Başvuru, ön görüşme, ekiple eşleştirme, ara değerlendirmeli programın kendisi ve sonunda işe alım kararı. Sekiz aşama, hizmet süreleri ve iki zorunlu belge.',
          },
        },
      },
      certificate: {
        title: 'Tamamlama belgesi',
        signatureTitlePlaceholder: 'örn. Satış temsilcisi',
        success: 'Sertifika oluşturuldu ve müşteri adayının belgelerine kaydedildi.',
      },
      matchFeedback: {
        reportSubtitle: 'Son {n} aydaki temsilci önerileri.',
        reportEmpty: 'Henüz kayıtlı temsilci önerisi yok.',
      },
      duplicates: {
        mergeErrors: {
          linked_by_mentorship: 'Bu iki kayıt bir fırsatla bağlı, yani aynı kişi değiller. Önce bunu çözün.',
          active_mentor_conflict: 'İki kaydın da aktif bir temsilcisi var ({a} ve {b}). Önce bu iki fırsattan birini kapatın, sonra birleştirin — hangi temsilcinin gerçek olduğuna sizin yerinize karar vermeyiz.',
        },
      },
      availability: {
        subtitle: 'Müşteri adayı toplantıları için haftalık tekrarlayan saatlerin',
        zoneUnset: 'Henüz bir saat dilimi seçmedin, bu yüzden bu saatler {zone} kabul ediliyor. Müşteri adaylarının doğru saati görmesi için kendi dilimini ayarla.',
      },
      apiDocs: {
        candidatesHint: 'En fazla 200 müşteri adayını mevcut pipeline aşamasıyla döner.',
      },
      mentorAvailability: {
        notAccepting: 'Müşteri adayı almıyor',
      },
      projects: {
        subtitle: 'Projeler — hesap destekli veya ekip içi',
        ownerMentor: 'Bir satış temsilcisi',
        ownerMentee: 'Bir müşteri adayı',
        members: 'üye',
        showcaseSubtitle: 'Ekip ve hesap projeleri.',
        noPublicHint: 'Bir projeye katılmak mı istiyorsun? Satış temsilcine katılabileceğin projeleri sor.',
        manageOwners: 'Owner ve temsilcileri yönet',
        roleMentorMember: 'Satış temsilcisi',
        roleMentee: 'Müşteri adayı',
        addMenteeMember: 'Müşteri adayı ekle (rolüyle)',
        noMenteesToAdd: 'Eklenecek müşteri adayı yok.',
      },
      weeklyReports: {
        mentorComment: 'Temsilci yorumu',
        commentPlaceholder: 'Müşteri adayı için geri bildirim ekle...',
        printDiary: 'Etkinlik günlüğünü yazdır',
      },
      meetings: {
        topics: [
          'Haftalık görüşme',
          'İlerleme değerlendirmesi',
          'Teknik demo',
          'İhtiyaç analizi',
          'Teklif sunumu',
          'Geri bildirim görüşmesi',
        ],
        scheduledCount: '{n} müşteri adayına davet gönderildi.',
      },
      messageTemplateAdmin: {
        subtitle: 'Satış temsilcilerinin tekrar tekrar yazdığı yanıtlar. Bir kez yaz, ihtiyacın olan dillerde — temsilci kendi dilinde ekler.',
        newTemplateHint: 'En az bir dili doldur. Temsilci yanıtı kendi dilinde alır, o dil yoksa İngilizcesine düşer.',
      },
      orphanApplicants: {
        subtitle: 'Genel başvuru bağlantısının açtığı, satış temsilcisinin reddettiği ve başka hiçbir yaşam belirtisi göstermeyen hesaplar. Bu hesaplara giriş yapılamaz ve sahipleri yoktur; karardan {grace} gün sonra otomatik olarak anonimleştirilirler. Temizlik hangi hesapları alacaksa önce burada listelenir.',
      },
      changeMentor: {
        action: 'Temsilciyi değiştir',
        title: 'Temsilciyi değiştir',
        context: 'Müşteri adayı: {mentee} · mevcut temsilci: {mentor}',
        hint: 'Tek adım, tek kayıt. Bu fırsata henüz hiçbir şey işlenmemişse temsilci yerinde düzeltilir. Geçmişi varsa fırsat “temsilci değişti” olarak kapatılır — asla “tamamlandı” olarak değil — ve yenisi aynı pipeline aşamasından devam eder. Notlar, kayıtlar ve mesajlar yazıldıkları fırsatta kalır.',
        newMentor: 'Yeni temsilci',
        selectNewMentor: 'Yeni temsilciyi seç…',
        privacy: 'Gerekçe ve not ekip için kaydedilir — not yalnızca admin denetim kaydında durur. Uygulamada iki temsilciye de gösterilmez; giden temsilciye sadece fırsatın sona erdiği söylenir.',
        submit: 'Temsilciyi değiştir',
        failed: 'Temsilci değiştirilemedi.',
        sameMentor: 'Bu kişi zaten bu müşteri adayının temsilcisi.',
        inactive: 'Bu fırsat artık aktif değil — sayfayı yenile.',
        transferredResult: '{mentee}, aynı pipeline aşamasında {mentor} kişisine devredildi. Önceki fırsat “temsilci değişti” olarak kapandı ve geçmişini koruyor.',
        reasons: {
          mentor_unavailable: 'Temsilci müsait değil',
          changed_goals: 'Müşteri adayının ihtiyaçları değişti',
          mentee_request: 'Müşteri adayı değişiklik istedi',
        },
        alreadyMentoredOffer: 'Bu kişinin temsilcisi zaten {mentor}. İkinci bir fırsat açmak yerine temsilcisini değiştir.',
        changeInstead: 'Bunun yerine temsilciyi değiştir',
        badgeReassigned: 'Temsilci değişti',
      },
      mentorships: {
        title: 'Fırsatlar',
        subtitle: 'Müşteri adaylarını temsilcilere ve hesaplara ata',
        assign: 'Fırsat ata',
        searchPlaceholder: 'Temsilci, müşteri adayı veya hesaba göre ara...',
        none: 'Henüz fırsat yok',
        mentor: 'Temsilci',
        mentee: 'Müşteri adayı',
        selectMentor: 'Temsilci seç',
        selectMentee: 'Müşteri adayı seç',
        mentorMenteeRequired: 'Temsilci ve müşteri adayı zorunludur',
        assignFailed: 'Fırsat oluşturulamadı.',
        planLimitReached: 'Plan sınırına ulaşıldı: {plan} planında {usage}/{limit} aktif fırsat. Mevcut müşteri adayları etkilenmez — daha fazlası için planı yükseltin.',
        invalidMentor: 'Bu temsilci atanamaz.',
      },
      company: {
        mentor: 'Temsilci',
        interestHint: 'Bu müşteri adayı hakkında ne düşündüğünü temsilciye bildir. Temsilciye bildirim gider.',
        notePlaceholder: 'Temsilci için isteğe bağlı not...',
        interestSaved: 'Kaydedildi — temsilciye bildirim gönderildi.',
        verifiedTitle: 'Temsilci tarafından doğrulandı',
        verifiedHint: 'Fırsat sürecinde doğrulanmış temsilci değerlendirmeleri ve proje çalışması.',
        verifiedEvaluations: 'Temsilci değerlendirmeleri',
      },
      programSurvey: {
        mentee: {
          communication: 'Muhatabınla iletişim, ihtiyaç duyduğunda yeterli miydi?',
        },
        mentor: {
          support: 'Ekipten aldığın destek, müşteri takibin için yeterli miydi?',
          workloadSustainability: 'Müşteri takibi yükün sürdürülebilir bir tempoda mıydı?',
        },
      },
      surveyTemplates: {
        programPre: {
          q: {
            goalsMentor: 'Müşteri adayının bu süreçten en çok ne kazanmasını istiyorsun?',
          },
        },
        pulse: {
          q: {
            mood: 'Fırsat şu anda nasıl gidiyor?',
          },
        },
      },
      relationTimeline: {
        actorRole: {
          MENTOR: 'temsilci',
          MENTEE: 'müşteri adayı',
        },
      },
      erasure: {
        confirmDelete: 'Bu işlem hesabı ve fırsat geçmişini kalıcı olarak siler. Geri alınamaz.',
      },
      todos: {
        subtitle: 'Listendeki her şey: muhatabının istedikleri, projelerinden gelenler ve kendine yazdıkların.',
      },
      mentorDirectory: {
        title: 'Satış temsilcileri',
        subtitle: 'Listelenmeyi seçen satış temsilcileri — seninle kimin çalışabileceğini gör',
        acceptingOnly: 'Yeni müşteri adayı kabul edenler',
        accepting: 'Müşteri adayı kabul ediyor',
        requestMentor: 'Bu temsilciyi iste',
        requestedMentorUnavailable: 'Bu temsilci artık müsait değil — aşağıdan başka bir temsilci seçebilirsin.',
        selfMatchFullError: 'Bu temsilci şu an kendi seçimiyle gelen müşteri adayı almıyor — başka birini seç ya da alanı boş bırak, bir yönetici seni atasın.',
        requestedMentorPending: 'Yanıt bekleyen bir talebin zaten var, bu yüzden bu temsilci talebine eklenmedi.',
        requestedMentorActiveMentorship: 'Zaten bir satış temsilcin var, bu yüzden bu talep başlatılmadı.',
        empty: 'Henüz listelenen satış temsilcisi yok. Temsilciler onay verdikçe burada görünür.',
        noMatches: 'Bu filtrelerle eşleşen satış temsilcisi yok.',
        loadError: 'Satış temsilcisi dizini yüklenemedi',
        showing: '{total} satış temsilcisinden {from}–{to} gösteriliyor',
        partialNotice: 'Bu liste eksik olabilir — yalnızca listelenen ilk {cap} satış temsilcisi taranabildi. Herkesi gördüğünden emin olmak için filtreleri daralt.',
        requestingMentor: '{name} adlı temsilciyi istiyorsun',
      },
      sourcePortal: {
        title: 'Müşteri adaylarım',
        subtitle: 'Yönlendirdiğin müşteri adaylarını gönder; bir satış temsilcisi onları alıp atayacak.',
        addMentee: 'Müşteri adayı ekle',
        submit: 'Müşteri adayı gönder',
        added: 'Müşteri adayı gönderildi',
        myMentees: 'Gönderilen müşteri adayları',
        none: 'Henüz müşteri adayı gönderilmedi',
        assignedTo: 'Temsilci:',
        pending: 'Temsilci bekliyor',
      },
      matchScore: {
        dimensions: {
          capacityHeadroom: 'Temsilci kapasitesi',
        },
        violations: {
          capacityHeadroom: 'Temsilcinin boş kapasitesi kalmamış',
          managerExclusion: 'Temsilci, bu müşteri adayının doğrudan yöneticisi',
        },
      },
      demo: {
        roles: {
          mentor: 'Satış temsilcisi',
          mentee: 'Müşteri adayı',
        },
      },
      testimonials: {
        admin: {
          roles: {
            mentor: 'satış temsilcisi',
            mentee: 'müşteri adayı',
          },
        },
      },
      tags: {
        notYourMentee: 'Yalnızca kendi müşteri adaylarını etiketleyebilirsin.',
      },
      releaseNotes: {
        feedDescription: '{product}’deki yeni özellikler ve iyileştirmeler.',
      },
      newsletter: {
        emailMentorTitle: 'Satış temsilcileri için',
        audienceMentee: 'Müşteri adayları',
        audienceMentor: 'Satış temsilcileri',
        audienceBoth: 'Müşteri adayları ve satış temsilcileri',
        audienceHint: 'Satış temsilcileri ayrıca "Satış temsilcileri için" bölümünü görür; müşteri adayları hiçbir zaman görmez.',
        mentorNote: 'Satış temsilcileri için',
        mentorNotePlaceholder: 'Bir satış temsilcisinin bu içerikle ne yapması gerektiği.',
        mentorNoteHint: 'Yalnızca satış temsilcilerine, yalnızca temsilci veya ortak sayılarda gösterilir.',
        previewAsMentee: 'Müşteri adayı',
        previewAsMentor: 'Satış temsilcisi',
        archiveMentorNote: 'Satış temsilcileri için',
      },
      modeSwitch: {
        mentor: 'Satış temsilcisi',
        mentee: 'Müşteri adayı',
        mentorHint: 'Temsilci görünümü: yalnızca kendi takip ettiğin müşteri adayları.',
        menteeHint: 'Müşteri adayı görünümü: kendi fırsatın — senin müşteri adayı olduğun taraf.',
      },
      menteeActivation: {
        placeholderNote: 'Bu müşteri adayı e-posta adresi girilmeden eklendiği için geçici bir adresi var ve giriş yapamıyor. Gerçek adresini yazarak hesabı aktive edebilirsin — kayıt, etkileşim geçmişi ve aşama geçmişi korunur.',
        noPasswordNote: 'Bu müşteri adayı henüz parola belirlemedi. Adres yanlışsa düzelt, sonra aktivasyon bağlantısını yeniden gönder.',
        mailFailedHint: 'E-posta gönderilemedi. Bu bağlantıyı müşteri adayıyla doğrudan paylaş:',
      },
      onboarding: {
        mentee: {
          subtitle: 'Seni doğru muhatap ve tekliflerle buluşturmamıza yardımcı ol',
        },
        mentor: {
          title: 'Satış Temsilcisi Profilini Oluştur',
          subtitle: 'Müşteri adaylarının seni tanıması ve müsait olduğun zamanları görmesi için birkaç kısa adım',
        },
      },
      stageClock: {
        mentee: {
          expectedBy: 'Muhatabın bir sonraki adımı {date} tarihine kadar atmayı planlıyor.',
          reassure: 'Bekleme süresi aşamadan aşamaya değişir — durumu merak ediyorsan muhatabına sormaya çekinme.',
        },
      },
      evaluation: {
        titleMentor: 'Satış temsilcini değerlendir',
        onMentor: 'Satış temsilcisi için',
      },
      profileForm: {
        mentorCapacity: 'Müşteri adayı kapasitesi',
        mentorCapacityHint: 'Aynı anda kaç müşteri adayı alabilirsin',
      },
      aiSummary: {
        consentRequired: 'Müşteri adayı AI özetlerine izin vermemiş. Hesap → Gizlilik ve onay bölümünden açabilir.',
      },
    },
    de: {
      documentRequirements: { search: 'Leads suchen', roles: { MENTEE: 'Lead', MENTOR: 'Vertriebsmitarbeiter', COMPANY: 'Account' }, reviewerRoles: { MENTOR: 'Vertriebsmitarbeiter' } },
      // Die Wiedervorlage (#2563) im Vertriebs-Wortlaut (#2875): das
      // Verkaufsbeispiel, das das Basiswörterbuch früher trug, und wer die
      // Notiz liest.
      followUp: {
        notePlaceholder: 'z. B. Wegen Preisen anrufen',
        visibility: 'Diese Notiz sehen nur der Zuständige dieses Datensatzes und die Admins; der Kontakt nie. Am Tag der Wiedervorlage bekommt der Zuständige eine Erinnerung.',
        aiHint: 'Drei Vorschläge aus dem Aktivitätsprotokoll und der Phase (verbraucht ein KI-Guthaben). Einen wählen, anpassen, speichern.',
        aiEmpty: 'Noch keine Aktivität protokolliert — zuerst eine anlegen.',
      },
      // Die Eingaben für gespendete Zeit auf der ROI-Seite (#1895), im Vertriebs-Wortlaut.
      roi: {
        screen: {
          mentorHours: 'Unbezahlte Vertriebsstunden, die bewertet werden',
          hints: {
            mentorHourValue: 'Bewertet gespendete Vertriebszeit, damit ein ehrenamtlich getragenes Programm nicht kostenlos wirkt.',
            mentorHours: 'Bei 0 lassen, sofern Ihre Organisation gespendete Vertriebszeit nicht als Kosten zählt.',
          },
        },
        categories: {
          MENTOR_TIME: 'Zeit der Vertriebsmitarbeiter',
        },
        steps: {
          mentorTimeCost: 'Nicht abgerechnete Zeit der Vertriebsmitarbeiter',
        },
        assumptions: {
          mentorHourValue: 'Wert einer Vertriebsstunde',
        },
      },
      seo: {
        homeTitle: '{product} — Marketing-CRM',
        homeDescription: 'Ein CRM, das Kunden durch eine Marketing-Pipeline begleitet – vom ersten Kontakt bis zum Abschluss.',
        applyAsMentorTitle: 'Bewerben',
        applyAsMentorDescription: 'Bewerben Sie sich für das Programm.',
        profileMentorTitle: '{name}',
        profileMenteeTitle: '{name}',
      },
      goals: {
        visibilityPair: 'Vertriebsmitarbeiter und Lead',
        visibilityProgram: 'Vertriebsmitarbeiter, Lead und Team',
        byMentor: 'Vom Vertriebsmitarbeiter erstellt',
        byMentee: 'Vom Lead erstellt',
      },
      surveyResults: {
        byMentor: 'Nach Vertriebsmitarbeiter',
        noRelationBreakdowns: 'Anonyme Antworten tragen weder Kohorte noch Zuständige, deshalb gibt es diese Aufschlüsselungen für diese Umfrage nicht.',
        role_MENTEE: 'Leads',
        role_MENTOR: 'Vertriebsmitarbeiter',
        audience_BOTH: 'Leads und Vertriebsmitarbeiter',
        createOnePerRole: 'Diese Vorlage fragt Vertriebsmitarbeiter mit anderem Wortlaut, daher ist es eine Umfrage pro Rolle — legen Sie für die andere Rolle eine zweite an.',
      },
      nav: {
        candidates: 'Leads',
        companyInquiries: 'Demo-Anfragen',
        myCompanies: 'Meine Accounts',
        mentorDirectory: 'Vertriebsmitarbeiter',
        mentors: 'Vertriebsmitarbeiter',
        mentorships: 'Deals',
        myMentees: 'Meine Leads',
        inviteMentee: 'Lead einladen',
        menteeActivity: 'Lead-Aktivität',
        mentorApplications: 'Bewerbungen als Vertriebsmitarbeiter',
        agreements: 'Zusammenarbeitsvereinbarung',
      },
      invite: {
        subtitle: 'Vertriebsmitarbeiter und Leads einladen',
        connectMentor: 'Diesem Vertriebsmitarbeiter zuordnen (optional)',
        connectMentee: 'Diesen Lead dem neuen Vertriebsmitarbeiter geben (optional)',
        connectHint: 'Hier gewählt, wird der Lead bei der Registrierung sofort zugeordnet — kein weiterer Schritt.',
        mentorTitle: 'Lead einladen',
        mentorAutoAssign: 'Wer sich über deinen Link registriert, wird automatisch dein Lead — kein Zuweisungsschritt. Der Link gilt einmalig und verfällt nach 7 Tagen.',
      },
      notifications: {
        automationEmail: { mentorCheckIn: { cta: 'Meine Leads öffnen' } },
        invitationEmail: {
          roles: { MENTOR: 'Vertriebsmitarbeiter', MENTEE: 'Lead' },
        },
        slaEscalationEmail: {
          body: 'Die Phasenfrist für {mentee} ist vor {days} Tagen abgelaufen, und die Phase hat sich seitdem nicht bewegt. Die zuständige Vertriebsperson, {mentor}, wurde beim Ablauf erinnert. Bestätige sie in der SLA-Warteschlange, wenn sich jemand darum kümmert.',
        },
        events: {
          'interaction.logged': 'Ein neuer Interaktionseintrag wurde hinzugefügt.',
          'deadline.slaEscalated': 'Die Phasen-Frist für {menteeName} ist seit {days} Tagen überschritten, und die Phase hat sich nicht bewegt (Vertrieb: {mentorName}).',
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
          'outcome.needsMessage': '{name} hat eine Ergebnisphase erreicht. Schreib eine Nachricht.',
          'duplicate.suspected': 'Ein neuer Eintrag könnte ein Duplikat eines vorhandenen Leads sein: {name}.',
          'outcome.placedElsewhere': 'Glückwunsch zu deinem nächsten Schritt! Deine Reise hier ist als abgeschlossen markiert — die Tür bleibt offen, wann immer du uns brauchst.',
          'goal.assigned': 'Zu deinem Deal wurde ein neues Ziel hinzugefügt: "{title}".',
          'evaluation.added': 'Zu deinem Deal wurde eine neue Bewertung hinzugefügt.',
          'mentorship_request.new': 'Neue Kontaktanfrage von {from}.',
          'mentorship_request.newGeneric': 'Eine neue Kontaktanfrage ist eingegangen.',
          'mentorship_request.approved': 'Deine Kontaktanfrage wurde genehmigt — sag deiner Ansprechperson Hallo!',
          'mentorship_request.rejected': 'Deine Kontaktanfrage wurde geprüft, konnte aber derzeit nicht genehmigt werden.',
          'mentorship_request.rematch': '{from} hat um eine andere Ansprechperson gebeten.',
          'mentorship_request.rematchGeneric': 'Ein Lead hat um eine andere Ansprechperson gebeten.',
          'mentorship_request.rematchApproved': 'Du hast eine neue Ansprechperson — deine bisherige betreut dich nicht mehr.',
          'mentorship_request.rematchRejected': 'Deine Anfrage nach einer anderen Ansprechperson wurde geprüft. Deine aktuelle Ansprechperson bleibt vorerst bei dir.',
          'mentorship_request.rematchMentorNotice': 'Dein Deal mit {menteeName} ist beendet — die Person wird von einem anderen Vertriebsmitarbeiter weiter betreut.',
          'application.received': '{name} hat sich als dein Lead angemeldet.',
          'mentor_application.new': '{name} hat sich als Vertriebsmitarbeiter beworben.',
          'mentor_application.approved': 'Deine Bewerbung als Vertriebsmitarbeiter wurde angenommen — willkommen an Bord!',
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
        types: {
          mentorship_request: 'Kontaktanfrage',
          mentor_application: 'Bewerbung als Vertriebsmitarbeiter',
        },
        rematchRequestedEmail: {
          subject: 'Neue Ansprechperson angefragt: {name}',
          heading: 'Neue Ansprechperson angefragt',
          body: '{name} hat um eine andere Ansprechperson gebeten. Der aktuelle Deal bleibt aktiv, bis Sie entscheiden.',
          privacy: 'Die angegebene Begründung liegt in der Admin-Warteschlange und wird dem aktuellen Vertriebsmitarbeiter nicht mitgeteilt.',
        },
        rematchMentorEmail: {
          subject: 'Dein Deal mit {name} ist beendet',
          heading: 'Ein Deal ist beendet',
          body: 'Dein Deal mit {name} ist beendet. Die Person wird von einem anderen Vertriebsmitarbeiter weiter betreut.',
          thanks: 'Danke für deine Zeit und deine Sorgfalt. Deine anderen Leads sind davon nicht betroffen.',
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
      // The SSO role-mapping card (#2839), see the EN block.
      organizations: {
        ssoRoleMappingsHint: 'Wer den Wert im Claim hat, erhält die Rolle. Die höchste Priorität gewinnt; bei Gleichstand die niedrigere Rolle. Ohne Treffer: Lead. Admin kann noch nicht zugeordnet werden.',
        ssoRoleNone: 'Noch keine Zuordnung — jeder SSO-Nutzer startet als Lead.',
        ssoRoleSyncHint: 'Aus: Bestehende Nutzer behalten ihre Rolle. An: Die Rolle folgt bei jeder Anmeldung der Zuordnung (nie für einen Admin; eine Anmeldung ohne Treffer ändert nichts).',
        relations: 'Deals',
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
            text: 'Hallo {name}, danke für Ihr Interesse an {product}! Ich bin ab jetzt Ihr Ansprechpartner — schreiben Sie mir in diesem Chat, wann immer etwas ist.',
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
        pilotBody: 'Wir richten das Konto ein, verbinden die Leads, die Sie bereits haben, und löschen Ihre Daten an dem Tag, an dem Sie es wünschen. Was es kostet, ist veröffentlicht und nicht verhandelt — Sie können die Zahl prüfen, bevor Ihnen jemand eine nennt.',
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
        tagline: 'Leads, Accounts und Deals in einer Pipeline — vom ersten Kontakt bis zum Abschluss.',
        becomeMentor: 'Vertriebsmitarbeiter werden',
      },
      auth: {
        signinSubtitle: 'Melden Sie sich bei Ihrem {product}-Konto an',
        registerSubtitle: 'Mit Ihrer Einladung registrieren',
        tokenHint: 'Fügen Sie den Einladungscode aus Ihrer E-Mail ein. Konten in diesem Produkt werden per Einladung angelegt.',
        dataSharingTitle: 'Wie Ihre Daten geteilt werden',
        dataSharingBody: 'Je nach Rolle können die von Ihnen hinzugefügten Angaben für andere sichtbar sein: Angaben und Aktivitätsverlauf eines Leads sehen der zuständige Vertriebsmitarbeiter und Administratoren. Vertriebsmitarbeiter sehen nur ihre eigenen Leads und Accounts. Einzelheiten im Datenschutzhinweis.',
        wantMentor: 'Möchtest du Vertriebsmitarbeiter werden?',
        becomeMentorPrompt: 'Möchtest du stattdessen Vertriebsmitarbeiter werden?',
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
          mentorCapacity: 'Legen Sie Ihre Lead-Kapazität fest',
        },
        guides: {
          profile: 'Ihre Angaben und Skills sind das, was ein Vertriebsmitarbeiter liest, bevor Sie je miteinander sprechen. Ein ausgefülltes Profil wird an die richtige Person geleitet, ein leeres wartet. Fünf Minuten jetzt ersparen ein erstes Gespräch voller Fragen, die schriftlich längst beantwortet wären.',
          cv: 'Lebenslauf oder Firmenprofil ist das, was Ihr Vertriebsmitarbeiter tatsächlich liest. Laden Sie die Fassung hoch, die Sie heute abschicken würden, auch wenn sie nicht perfekt ist. Halten Sie sich an Angaben, die stimmen und überprüfbar sind.',
          public: 'Ein öffentliches Profil ist eine auffindbare Seite ohne Telefonnummer, ohne E-Mail-Adresse und ohne Anschrift. Es ist freiwillig und umkehrbar: Schalten Sie es aus, ist die Seite in derselben Sekunde weg.',
          bio: 'Zwei oder drei Sätze dazu, was Sie machen und wobei Sie helfen können, reichen. Ein Lead liest das als Erstes, und etwas Konkretes hilft mehr als eine Positionsbezeichnung. Schreiben Sie es so, wie Sie es aussprechen würden.',
          interestsOrSkills: 'Die Zuweisung läuft darüber. Die Felder zu benennen, die Sie kennen — und die, die Ihnen Spaß machen —, sorgt dafür, dass ein passender Lead bei Ihnen landet und nicht ein zufälliger. Zwei, drei konkrete Einträge schlagen zehn vage.',
          mentorCapacity: 'Die Kapazität ist die Zahl der Leads, die Sie gleichzeitig betreuen wollen, und das Team hält sich daran: Ein Admin sieht sie, bevor er Ihnen jemanden zuweist. Setzen Sie sie niedrig und ehrlich an — ein gut betreuter Lead ist mehr wert als drei vernachlässigte. Erhöhen können Sie sie jederzeit.',
          availability: 'Ein Verfügbarkeitszeitraum ist ein wiederkehrendes Fenster in Ihrer eigenen Zeitzone, in dem Sie gebucht werden können. Ein paar davon lassen einen Lead eine Zeit wählen, ohne eine Kette von „Passt Dienstag?“-Mails. Ein Fenster ist kein Versprechen: In Ihrem Kalender steht erst etwas, wenn Sie die Buchung annehmen.',
          configurePipeline: 'Die Pipeline ist die Reihe von Stufen, die jeder Lead vom ersten Kontakt bis zum Abschluss durchläuft. Die eingebauten Stufen zu behalten ist völlig in Ordnung — deshalb ist dieser Schritt optional. Benennen oder sortieren Sie sie nur um, wenn Ihr Team wirklich anders zählt: Jede Board-Spalte, jeder Bericht und jedes Service-Level baut auf diesen Stufen auf.',
          documentRequirements: 'Viele Teams sammeln Papier ein — eine unterschriebene Vereinbarung, ein Bestellformular, einen Compliance-Nachweis. Sie hier zu deklarieren macht aus „alle per E-Mail hinterherjagen“ eine Liste, die die App verfolgt und an die sie erinnert, je Stufe und je Rolle. Nehmen Sie nur auf, was Sie wirklich brauchen: Jedes Dokument ist Arbeit, die Sie einem Kunden aufgeben.',
          evaluationTemplate: 'Der Bewertungsrahmen sind die wenigen Kriterien, nach denen Ihr Team einen Lead oder einen Deal bewertet. Sie vor der ersten Bewertung aufzuschreiben macht die Bewertungen zweier Vertriebsmitarbeiter vergleichbar. Drei bis sechs Kriterien reichen völlig, und der eingebaute Rahmen ist ein guter Start, solange Sie keine feste Meinung haben.',
          inviteMentors: 'Laden Sie zuerst Ihre Vertriebsmitarbeiter ein: Ein Lead ohne Verantwortlichen wartet, ein Mitarbeiter ohne Leads hat nur eine ruhige Woche. Laden Sie Leute ein, die persönlich schon zugesagt haben — die E-Mail ist die Formalität, nicht die Frage. Bitten Sie jede und jeden, nach dem Einloggen Kapazität und Verfügbarkeit zu setzen.',
          inviteMentees: 'Fügen Sie die Leads, die Sie schon haben, in einem Schwung hinzu statt tröpfchenweise — eine Pipeline sagt erst etwas aus, wenn Menschen darin sind. Niemand sieht die Daten anderer.',
          addCompany: 'Accounts sind die Unternehmen, an die Sie verkaufen, und ohne mindestens einen sind die letzten Stufen der Pipeline bedeutungslos. Tragen Sie die ein, mit denen Sie ohnehin sprechen, samt Kontaktadresse — bevor Sie sie brauchen. Festzuhalten, was ein Account sucht, sorgt dafür, dass später der passende Lead von selbst auftaucht.',
          assignMentorship: 'Hier beginnt die Pipeline wirklich: ein Vertriebsmitarbeiter, ein Lead und von da an eine gemeinsame Historie aus Gesprächen, Notizen und Stufenwechseln. Legen Sie den ersten Deal an, sobald es beide Seiten gibt — ein falscher Verantwortlicher ist leicht zu ändern. Jedes Board, jeder Bericht und jede Erinnerung baut auf diesen Deals auf.',
          firstInteraction: 'Eine festgehaltene Interaktion — ein Anruf, eine E-Mail, ein Termin — ist die Art, wie das Team sich erinnert, was gesagt wurde. Die erste zählt am meisten: Sie ist das, was eine Kollegin liest, bevor sie einen Lead übernimmt, und woran der Erinnerungsjob Stille misst. Halten Sie sie direkt nach dem Gespräch fest. Dieser Schritt ist optional: Er ist ein Meilenstein, kein Teil der Einrichtung.',
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
        selfMatchLimitHint: 'Wie viele Leads dich selbst wählen dürfen (Anfrage im Verzeichnis oder dein Link). Leer = wie deine Kapazität. Admins können dich trotzdem bis zu deiner Kapazität zuweisen. Eine persönliche Einstellung, nie ein Tarif-Limit.',
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
      // The report registry (#1903): the mentorship-only reports are refused for
      // a tenant without `mentorship`, but the column labels are shared.
      reports: {
        mentorWorkload: { title: 'Vertriebler-Auslastung', description: 'Aktive Deals je Vertriebler und wie viele die letzte Phase erreicht haben.' },
        weeklyReportCompliance: { description: 'Fällige, abgegebene, fehlende und verspätete Wochenberichte je Person im laufenden Zeitraum.' },
        col: { mentor: 'Vertriebler', intern: 'Person' },
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
      panel: {
        sales: 'Vertrieb',
        mentor: 'Vertriebsportal',
        mentee: 'Lead-Portal',
      },
      sales: {
        dashboard: { title: 'Deine Vertriebs-Pipeline', subtitle: 'Deine eigenen Leads und Accounts und was heute ansteht.' },
        stats: { open: 'Offene Leads', accounts: 'Accounts' },
        records: {
          title: 'Meine Leads',
          empty: 'Auf deinem Board ist noch kein Lead. Leg mit „Neuer Lead“ selbst einen an, oder ein Admin — oder die Einstellung für den Standard-Owner — weist sie dir zu.',
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
        dashSubtitle: 'Hier ist ein Überblick über deine Leads und Interaktionen',
        activeMentees: 'Aktive Leads',
        myMentees: 'Meine Leads',
        currentRelationships: 'Aktuelle aktive Deals',
        noActiveMentees: 'Keine aktiven Leads zugewiesen',
        exampleLogNote: 'Fortschritt beim aktuellen Angebot und nächste Schritte für den Deal besprochen.',
        goToMenteeToLog: 'Gehe zur Detailseite eines Leads, um eine Interaktion zu protokollieren',
        interactionSearchPlaceholder: 'Betreff, Notizen oder Lead suchen...',
        menteeDormantMatchOne: '1 inaktiver Lead entspricht diesem Filter und bleibt ausgeblendet.',
        menteeDormantMatchMany: '{n} inaktive Leads entsprechen diesem Filter und bleiben ausgeblendet.',
        menteesSubtitle: 'Alle deine Deals',
        noMenteesAssigned: 'Noch keine Leads zugewiesen',
        noMenteesHint: 'Füge deinen ersten Lead hinzu oder teile deinen Bewerbungslink.',
        interactionLogsSubtitle: 'Alle deine protokollierten Interaktionen mit Leads',
        backToMentees: 'Zurück zu den Leads',
        addMentee: 'Lead hinzufügen',
        newMentee: 'Neuer Lead',
        menteeCreated: 'Lead erstellt',
        setPwLinkHint: 'Wir haben dem Lead einen Link gesendet, um sein Passwort zu setzen und sein Konto zu aktivieren. Falls er nicht ankommt, teile diesen Link direkt mit ihm:',
      },
      emptyStates: {
        board: {
          adminBody: 'Jeder Deal erscheint hier als Karte, in der Phase, die er erreicht hat. Lege die ersten Leads an — sobald ein Vertriebsmitarbeiter sie übernimmt, taucht ihre Karte auf.',
          mentorBody: 'Deine Leads erscheinen hier als Karten, sobald sie dir zugewiesen sind.',
        },
        companies: {
          adminBody: 'Unternehmen sind die Accounts, an die du verkaufst: sobald eines existiert, kannst du ihm seinen Bedarf, Ansprechpersonen und die offenen Deals zuordnen.',
        },
        candidates: {
          adminBody: 'Wer sich anmeldet oder eine Einladung annimmt, landet in dieser Liste — mit Vertriebsmitarbeiter, Account und Phase. Sende die erste Einladung, dann füllt sich die Liste von selbst.',
        },
        requisitions: {
          companyBody: 'Eine Anforderung sagt den Vertriebsmitarbeitern, für welche Stelle ihr einstellt, wie viele Leute ihr braucht und welche Skills zählen. Lege eine an, damit euch passende Personen vorgeschlagen werden.',
        },
        interviewRequests: {
          mentorBody: 'Wenn ein Account einen deiner Leads treffen möchte, erscheint die Anfrage hier samt Terminvorschlägen, und du vereinbarst das Treffen von dort aus.',
        },
        weeklyReports: {
          menteeBody: 'Ein Wochenbericht ist eine kurze Notiz darüber, was du getan hast, wie lange es gedauert hat und was dich blockiert. Schreibe den ersten im Formular oben, damit deine Ansprechperson ihn kommentieren kann.',
          mentorBody: 'Wochenberichte erscheinen hier, sobald dein Lead sie einreicht — die neuesten zuerst — und du kannst freigeben oder Änderungen erbitten. Bisher wurde nichts eingereicht.',
        },
        documents: {
          mentorBody: 'Dein Lead hat noch nichts hochgeladen. Verträge, Bestellformulare und Zertifikate erscheinen hier, sobald sie kommen, samt Versionshistorie.',
          menteeBody: 'Hier liegen deine Verträge, Bestellformulare und Zertifikate. Lade unten das erste hoch, dann sieht deine Ansprechperson es sofort.',
        },
        portalGoals: {
          title: 'Noch keine Ansprechperson zugewiesen',
          menteeBody: 'Ziele, Bewertungen und Wochenberichte gehören zu einem Deal und öffnen sich, sobald ein Admin dir eine Ansprechperson zuweist. Ein vollständiges Profil beschleunigt das.',
        },
        todos: {
          body: 'Diese Liste hält zusammen, was dir deine Ansprechperson gegeben hat, was deine Projekte brauchen und was du selbst notierst. Schreibe die erste Zeile in das Feld oben.',
        },
      },
      landing: {
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
        pipelineNote: 'Nicht jeder Lead schließt ab: Verlorene Deals werden ebenfalls erfasst, damit der Funnel die Wahrheit sagt.',
        stageApply: 'Neuer Lead',
        stageInterview: 'Kontaktiert',
        stageInternship: 'Angebot gesendet',
        stageHired: 'Gewonnen',
        ctaTitle: 'Bereit, jeden Deal an einem Ort zu sehen?',
        ctaSubtitle: 'Richten Sie Ihre Pipeline in Minuten ein — Ihr Team meldet sich per Einladung an.',
        ctaMentee: 'Anmelden',
        trans5T: 'Einwilligung als Mechanismus',
        trans5D: 'Kundendaten sieht niemand außerhalb Ihres Teams; jede Einwilligung wird mit Version erfasst und ist jederzeit widerrufbar. E-Mail und Telefon erscheinen auf keiner öffentlichen Seite.',
        badge: 'Marketing-CRM · Leads verfolgen · Abschlüsse erzielen',
        heroTitle: 'Jeder Lead, jedes Gespräch, jeder Abschluss —',
        heroAccent: 'in einer Pipeline.',
        heroSubtitle: 'Verfolgen Sie Ihre Kunden vom ersten Kontakt bis zum Abschluss. Sehen Sie auf einen Blick, wo jeder Deal steht, wer ihn zuletzt bearbeitet hat und was als Nächstes zu tun ist — statt es aus einer Tabelle zusammenzusuchen.',
        featuresTitle: 'Alles, was Ihr Team zum Abschluss braucht',
        becomeMentor: 'Möchten Sie als Vertriebsmitarbeiter mitmachen?',
        fMentorT: 'Selbstverwaltung für Mitarbeiter',
        fMentorD: 'Vertriebsmitarbeiter fügen ihre eigenen Leads hinzu, protokollieren Meetings, Feedback, E-Mails, Anrufe und WhatsApp-Chats, führen private Notizen und sehen eine „Braucht Aufmerksamkeit“-Liste auf ihrem Dashboard — Admins können das ebenfalls.',
        fGrowthD: 'Deal-Projekte mit Aufgabenlisten und Fortschritt, persönliche Ziele, strukturierte Zwischen- und Abschlussbewertungen in beide Richtungen und ein integriertes Q&A zwischen Lead und Vertriebsmitarbeiter.',
        roleMentor: 'Vertriebsmitarbeiter',
        roleMentee: 'Lead',
        heroModel: 'Ein Preis pro Benutzer — keine versteckten Zusatzkosten.',
        freeCoreBody: 'Nachrichten, Termine, Ziele, Bewertungen und die gesamte Pipeline sind in jedem Plan enthalten — abgerechnet pro Nutzer, ohne versteckte Zusatzkosten.',
        liveMentors: '{n} Vertriebsmitarbeiter',
        liveWaiting: '{n} Leads warten auf einen Mitarbeiter',
        pickMenteeT: 'Ich suche eine Lösung',
        pickCompanyD: 'Lernen Sie den Lead über den Mitarbeiter kennen, der monatelang mit ihm gearbeitet hat.',
        audCompanyTitle: 'Lernen Sie den Lead nicht über seinen Lebenslauf kennen, sondern über den Vertriebsmitarbeiter, der monatelang mit ihm gearbeitet hat.',
        audCompanySubtitle: 'Begleiten Sie Ihre Leads ab dem ersten Tag und treffen Sie die Entscheidung anhand einer über Monate gewachsenen schriftlichen Aufzeichnung statt anhand zweier Gespräche. Wir sind im Pilotbetrieb: Wir legen den Zugang an, wir berechnen nichts, es gibt keinen Vertrag.',
        audCompany1T: 'Wo steht Ihr Lead, und wie läuft es?',
        audCompany1D: 'Ein Bildschirm zeigt jeden mit Ihrem Account verknüpften Lead: in welcher Phase er ist, wer sein Vertriebsmitarbeiter ist und wie der Funnel aussieht. Gesprächsnotizen und Ziele führt der Mitarbeiter; Sie lesen den Status und die periodische Bewertung des Mitarbeiters. Schreibrechte haben Sie nicht — damit die Seite, die die Aufzeichnung führt, unabhängig bleibt.',
        audCompany2D: 'Der Ablauf läuft auf einer Linie: Deal beginnt → Deal läuft → abschlussbereit → gewonnen. Sie lernen den Lead über Monate echter Arbeit kennen, nicht über eine Gesprächsleistung.',
        audCompany3D: 'Der Lead hat bereits einen Vertriebsmitarbeiter: jemanden, der Ziele setzt, sich regelmäßig trifft, den Fortschritt aufschreibt und periodische Bewertungen erstellt.',
        audCompany4T: 'Ein Lead-Zeugnis mit dem Namen eines Vertriebsmitarbeiters darunter.',
        audCompany4D: 'Für jeden Lead, der mit Ihrem Account einen Deal beginnt, gibt sein Vertriebsmitarbeiter zweimal — zwischendurch und am Ende — Punkte und einen schriftlichen Kommentar zu vier Themen ab: Fachkompetenz, Kommunikation, Verlässlichkeit, Entwicklung. Daneben stehen die tatsächlich erledigten Projektaufgaben. Das Zeugnis ist das Ergebnis gemeinsamer Zeit: Der Pool ist der Ort des Kennenlernens, nicht der Entscheidung. Der Zugriff von Accounts auf Bewertungen ist eine Premium-Berechtigung und wird heute von Hand freigeschaltet.',
        stories: {
          roles: {
            mentor: 'Vertriebsmitarbeiter',
            mentee: 'Lead',
          },
        },
        faqMentee5A: 'Ein Lead zahlt nie etwas. Das Team, das Sie betreut, zahlt pro Nutzer — wir verkaufen ihm die Software, nicht Ihre Daten.',
        faqCompany1A: 'Wir legen den Zugang an und verknüpfen Ihre bestehenden Leads selbst; wir schicken Ihnen keinen Link, bevor mindestens ein echter Lead im Panel steht.',
        ctaMentor: 'Als Vertriebsmitarbeiter bewerben',
      },
      featureCatalog: {
        title: 'Alles, was {product} kann',
        subtitle: 'Der vollständige Funktionskatalog — vom Erstkontakt bis zum Abschluss, für Ihr ganzes Team.',
        categories: { collaboration: 'Zusammenarbeit' },
        items: {
          messaging: { d: 'Ein zentraler Posteingang mit einem Thread pro Deal, Anhängen und beantwortbarer E-Mail-Spiegelung — antworte aus deinem Mailprogramm, und die Antwort landet im Thread. Nachrichten erscheinen live, solange der Posteingang offen ist, und können dein Gerät auch bei geschlossener App benachrichtigen. Eine halb geschriebene Antwort bleibt pro Gespräch erhalten, bis du sie sendest, und du siehst, wenn die andere Person schreibt. Antworten, die du immer wieder gibst, liegen in einem gemeinsamen Pool vorgefertigter Antworten — einmal auf Englisch, Türkisch und Deutsch verfasst, mit einem Klick in deiner eigenen Sprache eingefügt.' },
          videoCalls: { d: 'Starte mit einem Klick einen Anruf mit einem Lead, einem Account-Team oder einem Chat — er läuft in einem Seitenpanel neben dem Datensatz auf unserem eigenen Jitsi-Tenant: kein Konto, keine Installation, kein Zeitlimit. Muss ein Anruf auf den freien öffentlichen Raum ausweichen, sagt das Panel das, bevor jemand beitritt, samt Ein-Klick-Weg zum Weiterreden. Der Link geht per E-Mail an alle Eingeladenen und funktioniert in jedem Browser.' },
          externalGuests: { d: 'Ein Meeting besteht nicht immer nur aus dem eigenen Team. Tippe eine beliebige E-Mail-Adresse in die Planung, und diese Person ist im selben Raum eingeladen — mit denselben Ja/Nein-Buttons, ohne Konto, ohne Registrierung und mit .ics für den eigenen Kalender. Du siehst, wer zugesagt hat, und eine an die falsche Adresse gegangene Einladung lässt sich zurückziehen; ihr Link funktioniert dann nicht mehr.' },
          ownWorkspace: { t: 'Ein Arbeitsbereich für jeden Vertriebsmitarbeiter', d: 'Jeder Vertriebsmitarbeiter meldet sich in seinem eigenen Bestand an: seine Leads und Accounts, fällige Wiedervorlagen und Testphasen-Enden, sein eigenes Board — und das Gespräch, das er gerade geführt hat, gleich erfassen. Die Deals eines Kollegen oder einer anderen Organisation liegen nicht einen versteckten Reiter entfernt; auf dieser Seite gibt es sie schlicht nicht.' },
          inviteLinks: { d: 'Lade jemanden ein, dessen Adresse du nicht kennst: Feld leer lassen, und es entsteht ein einmalig gültiger 7-Tage-Link zum persönlichen Übergeben. Wer sich damit registriert, ist sofort mit der einladenden Person verbunden — und eine private Notiz hält eine Wand aus Links unterscheidbar.' },
          pricing: {
            d: 'Die Preisliste steht auf der Website und nicht in einem Angebot: Plan-Bänder, Admin-Plätze, die Überschreitungsgebühr und alle Zusatzpakete. Eine einzige Abrechnungseinheit — der aktive Deal — macht Vertriebsmitarbeiter und Leads strukturell nicht abrechenbar, und die Seite nennt auch, was in keinem Plan abgerechnet wird.',
          },
          rematch: {
            t: 'Eine andere Ansprechperson anfragen',
            d: 'Ein Lead, bei dem es mit dem Vertriebsmitarbeiter nicht passt, kann das Team mit Grundkategorie und optionaler Notiz um eine andere Ansprechperson bitten. Der laufende Deal bleibt vollständig aktiv, bis ein Admin entscheidet, der Wechsel erfolgt in einem Schritt — niemand steht ohne Ansprechperson da — und dem bisherigen Vertriebsmitarbeiter wird nur mitgeteilt, dass der Deal übergeben wurde, nie was über ihn geschrieben wurde.',
          },
          activityReport: {
            d: 'Einwilligungsbasierte Lead-Aktivitätsübersichten für Vertriebsmitarbeiter und Admins: Logins, Verweildauer, besuchte Seiten und erledigte To-dos.',
          },
          menteeOwnProject: {
            d: 'Ein Lead wird nicht nur Projekten zugewiesen — er kann selbst eines starten. Wer ein Projekt im Portal anlegt, besitzt es: alle Felder bearbeiten und die To-dos führen. Das eigene Projekt startet privat und bleibt ein Ein-Personen-Team, bis ein Admin jemanden hinzufügt oder es im Schaufenster veröffentlicht — danach wächst das Team über Beitrittsanfragen, die der Eigentümer genehmigt.',
          },
          menteeInsights: {
            d: 'Die Aktivitätsübersicht, die Vertriebsmitarbeiter und Team über einen Lead lesen, liest der Lead jetzt auch selbst — auf einer eigenen Seite im Portal: Ziele, Meetings, Interaktionen, Phasenwechsel und Nachrichten, dazu Verweildauer und besuchte Seiten, solange das Aktivitäts-Tracking an ist. Kein Vergleich mit anderen, keine Punkte, und nie eine Bezahlfunktion.',
          },
          publicProfiles: {
            d: 'Leads und Vertriebsmitarbeiter können sich für eine öffentliche Profilseite ohne personenbezogene Daten entscheiden — wird ihr Link auf LinkedIn, WhatsApp oder Slack geteilt, entfaltet er sich zu einer Karte mit Name, Rolle, Ort und Top-Skills.',
          },
          interviewRequests: {
            d: 'Accounts setzen Leads je Stellenanforderung auf die Shortlist und fragen Interviews an; Team oder zuständiger Vertriebsmitarbeiter prüfen jede Anfrage vor der Planung.',
          },
          aiPackage: {
            d: 'Lebenslauf-Feedback und Interviewvorbereitung für Leads, Interaktionszusammenfassungen für Vertriebsmitarbeiter, KI-gestützte Zuordnung und Themen aus Bewertungskommentaren und Wochenbericht-Hindernissen für Admins — jedes Thema mit den Zeilen dahinter verknüpft. Alles einwilligungs- und kontingentgesteuert.',
          },
          matchingRules: {
            d: 'Lege fest, was eine gute Zuordnung zu Vertriebsmitarbeitern ausmacht — Skills, Sprache, Fachgebiet, Stadt, Zeitzone, Kapazität — und wie stark es zählt, markiere die nicht verhandelbaren Regeln, und niemand wird der eigenen Führungskraft oder einer früheren Ansprechperson zugeordnet. Ein Probelauf zeigt, wer wem zugeordnet würde, bevor du dich festlegst, und nennt die Regel, die zu streng ist. Jeder Score erklärt sich Regel für Regel.',
          },
          matchQuality: {
            d: 'Jeder Vorschlag eines Vertriebsmitarbeiters durch die Plattform wird mit der Position erfasst, auf der er gezeigt wurde, und ein Verwerfen per Klick fragt nach dem Grund — falsches Fachgebiet, keine Kapazität, Sprache, bereits zugeordnet. Die Analyseseite beantwortet damit die Frage, die jede Teamleitung irgendwann stellt: Wie oft wird der Vorschlag tatsächlich übernommen, und wird der erstplatzierte Vertriebsmitarbeiter wirklich gewählt? Ein Vorschlag bleibt ein Vorschlag — entschieden wird immer von einem Menschen.',
          },
          selfServe: {
            t: 'Self-Service-Lead-Aufnahme',
            d: 'Leads registrieren sich selbst, durchlaufen das Onboarding und fragen eine Ansprechperson an; Admins genehmigen aus einer Warteschlange.',
          },
          outcomeComms: {
            d: 'Endet ein Deal, sagt das Portal, wie es steht und was als Nächstes möglich ist, statt still einen Status zu ändern; Vertriebsmitarbeiter:innen bekommen eine fertige Nachricht zum Bearbeiten statt einer leeren Seite. Automatischer Versand ist standardmäßig aus — jede Absage liest ein Mensch, bevor sie rausgeht. Ein Lead, der anderswo fündig wird, gilt nicht als Misserfolg und bekommt einen eigenen Text.',
          },
          joinRequests: {
            d: 'Öffentliche Projekte nehmen Beitrittsanfragen an, die der Owner mit einem Klick freigibt; und alle — Lead, Vertriebsmitarbeiter oder Admin — haben einen persönlichen Einladungslink, der festhält, wer jemanden gebracht hat.',
          },
          todos: {
            d: 'Alles, was jemand zu tun hat, an einem Ort: was der Vertriebsmitarbeiter gegeben hat, was die Projekte brauchen, offene Projektziele zum Übernehmen und eigene Notizen — Erledigtes wird archiviert, nicht gelöscht. Eine Aufgabe aus dem gemeinsamen, mehrsprachigen Pool bleibt damit verknüpft: einmal neu formuliert, ändert sie sich für alle, die sie haben — jeweils in deren Sprache. Jede Aufgabe kann ein Fälligkeitsdatum tragen: das Nächstfällige steht oben, Undatiertes unten, Überfälliges wird als Text und nicht nur in Farbe ausgewiesen, und Vertriebsmitarbeiter und Admins lesen auf einer Liste, was ihre Leute offen haben.',
          },
          dualRole: {
            d: 'Ein Vertriebsmitarbeiter kann auch Lead sein. Wer andere betreut, braucht manchmal selbst eine Ansprechperson — bekommt ein Vertriebsmitarbeiter einen eigenen, öffnet sich neben den Vertriebsseiten das Lead-Portal, mit einem Ansichtsschalter in der Seitenleiste zum Wechseln. Admins können beide Seiten eines Deals frei besetzen; niemand lässt sich mit sich selbst verknüpfen.',
          },
          weeklyReports: {
            t: 'Wöchentliche Lead-Berichte',
            d: 'Leads schreiben wöchentlich einen Bericht, speichern Entwürfe und drucken ihr Tagebuch; Vertriebsmitarbeiter genehmigen Einreichungen oder fordern Änderungen an. Fehlende Berichte erscheinen in der Aufmerksamkeit-Liste und in einer wöchentlichen Erinnerung; Koordinatoren erhalten eine Abgabe-Matrix für den ganzen Zeitraum mit Erinnerung per Klick, XLSX-Export und einem druckbaren Berichtsheft je Lead.',
          },
          newsletter: {
            d: 'Kurze Ausgaben mit Emoji-Tipps zu CV und Bewerbungsgesprächen — einmal auf Englisch, Türkisch und Deutsch geschrieben, an jede Leserin in ihrer Sprache verschickt. Manuell oder wöchentlich, zweiwöchentlich, monatlich geplant; Vertriebsmitarbeiter erhalten zur gleichen Ausgabe die Coaching-Perspektive, jeder Versand wird archiviert, und ein Klick genügt zum Abmelden.',
          },
          mentorSelfApply: {
            t: 'Self-Service-Bewerbungen als Vertriebsmitarbeiter',
            d: 'Jeder kann sich ohne Konto als Vertriebsmitarbeiter bewerben; Admins prüfen die Warteschlange, starten die Prüfung, genehmigen oder lehnen ab — bei Genehmigung wird das Konto des Vertriebsmitarbeiters automatisch erstellt oder hochgestuft.',
          },
          offers: {
            d: 'Erstelle, prüfe in der Vorschau und sende ein Angebot in drei Schritten direkt von der Deal-Karte eines Leads; der Lead nimmt im Portal an oder lehnt (mit Grund) ab, die Entscheidung bleibt dauerhaft sichtbar, und überfällige Angebote laufen von selbst ab — jeder Schritt wird protokolliert und gemeldet. Eine Angebotsübersicht für Admins beantwortet, was noch offen ist, was diese Woche abläuft und was warum abgelehnt wurde.',
          },
        },
      },
      pricing: {
        heroBadge: '{product}-Preise',
        heroTitle: 'Ein Preis pro Nutzer, keine Überraschungen',
        heroSubtitle: 'Pläne für Vertriebsteams, abgerechnet pro Nutzer. Keine versteckten Zusatzkosten — und wer es selbst betreiben will: Der Code ist Open Source.',
        discountsTitle: 'Was schon heute gilt',
        freeTitle: 'Abrechnung pro Nutzer, keine Überraschungen',
        freeBody: 'Die Pläne werden pro Nutzer im Vertriebsteam abgerechnet. Keine versteckten Zusatzkosten — jeder Plan und seine Grenzen stehen auf dieser Seite.',
        neverMetered: {
          messaging: 'Nachrichten zwischen Vertriebsmitarbeiter und Lead',
          portal: 'Das Lead-Portal',
        },
        planDesc: {
          employer_free: 'Eine Markenseite und die Antwort auf eine vom Vertriebsmitarbeiter freigegebene Shortlist.',
        },
        meteringCounted: 'Gezählt: ein Deal im Status ACTIVE mit irgendeiner protokollierten Aktivität im Kalendermonat.',
        meteringNeverCounted: 'Nie gezählt: Vertriebsmitarbeiter und Leads. Sie sind keine Einheit, die wir abrechnen können.',
        employerSubtitle: 'Eine eigene Geldbörse mit einem anderen Käufer. Nichts hiervon verändert, was ein Team zahlt, und nichts, was ein Account zahlt, erreicht die Lead-Seite.',
        faq1Q: 'Zahlen Vertriebsmitarbeiter oder Leads jemals?',
        faq1A: 'Nein — und das ist keine Richtlinie, die wir still ändern könnten, denn sie sind nicht die Abrechnungseinheit. Es gibt keinen Vertriebs- und keinen Lead-Platz zu verkaufen.',
        faq2A: 'Ein Vertriebsmitarbeiter, einem Lead zugeordnet, im Status ACTIVE, mit mindestens einer protokollierten Aktivität in diesem Kalendermonat. Ein pausierter Deal wird nicht gezählt, ein abgeschlossener hört in dem Monat auf zu zählen, in dem er endet.',
        ctaMenteeT: 'Ich möchte einen Vertriebsmitarbeiter',
        ctaMentorT: 'Ich möchte Leads betreuen',
        ctaMentorA: 'Als Vertriebsmitarbeiter bewerben',
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
      slaQueue: {
        colOwner: 'Vertrieb',
        levelMentor: 'Vertrieb informiert',
        complianceDefinition: 'Von den Phasenwechseln im Zeitraum aus einer Phase mit Servicelevel der Anteil, der vor Ablauf dieses Servicelevels stattfand — gemessen ab dem Eintritt des Leads in die Phase, in Kalendertagen, gegen die heute eingestellten Servicelevel. Leads im Wiederansprache-Pool und Phasen mit angehaltener Uhr zählen nicht.',
      },
      stageSla: {
        escalateHint: 'Eskalieren nach: Ist eine Phase so viele Tage nach Ablauf ihrer Frist noch überfällig, werden auch die Administratoren der Organisation informiert — einmal. Bleibt das Feld leer, wird wie bisher nur die Vertriebsperson erinnert.',
        scopeMentor: 'Vertrieb',
        allMentors: 'Alle Vertriebsmitarbeitenden',
        overrideHint: 'Sie bearbeiten eine Ausnahme. Für diese Datensätze gilt sie vor der Zahl der Organisation — zuerst Vertriebsperson und Kohorte zusammen, dann Vertriebsperson, dann Kohorte, zuletzt die Organisation. Lassen Sie eine Phase leer, um zu erben. Eine leere Eskalation wird ebenfalls geerbt; Board-Limits bleiben organisationsweit.',
        sourceMentor: 'diese Vertriebsperson',
        sourceMentorCohort: 'diese Vertriebsperson in dieser Kohorte',
        subtitle: 'Wie lange jemand in einer Phase warten darf, bevor der zuständige Vertriebsmitarbeiter gewarnt wird. Eine leer gelassene Phase hat keine Regel — eine Organisation ohne Regeln arbeitet genau wie bisher weiter.',
      },
      share: { title: 'Mit {product} geteilt' },
      publicProfile: {
        poweredBy: '{product}',
        mentor: 'Vertriebsmitarbeiter',
        activeMentees: 'Aktive Leads',
        evaluationTitle: 'Bewertung des Vertriebsmitarbeiters',
        evaluationByMentor: 'Vertriebsmitarbeiter:in',
      },
      imprint: { intro: 'Wer diese {product}-Instanz betreibt und wie man ihn erreicht.' },
      privacy: {
        intro: 'Wir speichern die von dir bereitgestellten Informationen, um Leads, Accounts und Deals zu verwalten. Dieser Hinweis erklärt, was wir verarbeiten, warum, wer es sehen kann, wie lange wir es aufbewahren und welche Rechte du hast (DSGVO Art. 13–15).',
        controllerBody: 'Verantwortlicher für die hier verarbeiteten personenbezogenen Daten ist {operator}, Betreiber dieser {product}-Instanz. Anschrift und weitere Kontaktdaten stehen im Impressum.',
        controllerUnset: 'Verantwortlicher ist, wer diese {product}-Instanz betreibt; die Angaben stehen im Impressum dieses Deployments.',
        purposesBody: 'Zum Betrieb der Plattform: Verfolgung von Leads und Accounts durch die Vertriebs-Pipeline, Zuordnung zu Vertriebsmitarbeitern, Protokollierung von Interaktionen, Terminplanung und Kommunikation. Setzt ein Vertriebsmitarbeiter die Adresse dieses CRM in Blindkopie (BCC) auf eine E-Mail an Sie oder leitet er Ihre Antwort dorthin weiter, werden Datum, Betreff und die beteiligten E-Mail-Adressen als Interaktion an Ihrem Account festgehalten; Inhalt und Anhänge werden nicht gespeichert.',
        legalBasisBody: 'Die Verarbeitung stützt sich auf deine Einwilligung (Art. 6(1)(a)) und auf das berechtigte Interesse am Betrieb des Vertriebsprozesses (Art. 6(1)(f)). Optionale Verarbeitung erfordert stets eine gesonderte Einwilligung.',
        recipientsBody: 'Je nach Rolle: Datensatz und Interaktionsverlauf eines Leads sind für den zuständigen Vertriebsmitarbeiter und für Administratoren sichtbar. Vertriebsmitarbeiter sehen nur ihre eigenen Leads und Accounts. Wir verkaufen deine Daten nicht. Auf der öffentlichen Startseite wird der Live-Chat nur nach Zustimmung zu Marketing-Cookies von tawk.to geladen; dabei erhält tawk.to deine IP-Adresse und alles, was du in den Chat schreibst. Lehnst du ab oder nutzt den Chat nicht, wird nichts an sie übermittelt.',
        use: 'Deine Daten werden nur zum Betrieb der Plattform verwendet — Pipeline-Tracking und Kommunikation.',
        aiBody: 'Eine Funktion kann Text an einen KI-Anbieter senden: Wenn ein Admin einen Lead einem Vertriebsmitarbeiter zuordnet, sendet der Vorschlag passender Vertriebsmitarbeiter Fähigkeiten, Position und Interessen des Leads sowie Fähigkeiten, Interessen und aktuelle Auslastung von bis zu fünf Vertriebsmitarbeitern — ohne Namen oder Kennung auf beiden Seiten. Sie braucht keine Einwilligung, weil nichts gesendet wird, was jemanden identifiziert, und ein Admin kann sie für die ganze Organisation abschalten. Weder der gesendete noch der erzeugte Text wird gespeichert. Was sie sendet, was sie bewusst zurückhält und wer der Anbieter ist, steht vollständig auf der KI-Seite.',
      },
      terms: {
        intro: 'Mit der Nutzung von {product} stimmst du diesen Bedingungen zu.',
        use: 'Nutze die Plattform nur für rechtmäßiges Kunden- und Vertriebsmanagement.',
      },
      trust: {
        operatorUnset: 'Diese Instanz hat noch keinen Betreiber veröffentlicht. {product} ist Open Source, und jedes Deployment nennt seinen eigenen Betreiber im eigenen Impressum.',
        posture: {
          dataD: 'Deine Daten werden nicht verkauft. Im Code gibt es keinen Zahlungsdienstleister, kein Werbenetzwerk und keinen Datenhändler.',
          crmD: 'Analytics und Live-Chat werden ausschließlich aus der öffentlichen Hülle geladen, nie aus der Anwendung selbst. Ein Seitenaufruf im eingeloggten Bereich würde den Namen eines Leads an einen Anbieter tragen — deshalb kann er dort nicht entstehen.',
        },
        residencySelfHost: '{product} steht unter AGPL-3.0-or-later. Ihr dürft eine eigene Instanz betreiben, auf eurer eigenen Infrastruktur, in eurer eigenen Rechtsordnung, ohne jemanden zu fragen und ohne jemanden zu bezahlen. Das ist die stärkste Standortgarantie, die dieses Projekt geben kann, weil sie uns vollständig aus der Frage nimmt. Eine Dual-Lizenz ist beim Rechteinhaber Mehmet Erşahin erhältlich — eine natürliche Person, kein Unternehmen.',
        freeNote: 'Nichts auf dieser Seite ist ein kostenpflichtiges Add-on.',
      },
      accessibility: {
        intro: 'Wir entwickeln {product} so, dass Vertriebsmitarbeiter, Vertriebsleitung oder Administration es mit Tastatur, Screenreader, Bildschirmlupe oder einem Handy auf Armlänge bedienen können. Diese Erklärung sagt, an welchem Standard wir uns messen, wie wir das prüfen, was noch nicht funktioniert und an wen du dich wendest, wenn du auf eine Barriere stößt.',
        scopeBody: 'Für die aus dieser Installation ausgelieferte {product}-Webanwendung: die öffentlichen Seiten, den Anmeldeweg und die dahinterliegenden Bereiche für Vertrieb und Verwaltung. Nicht abgedeckt sind hochgeladene Dateien, E-Mails in der Darstellung fremder Mail-Programme sowie die weiter unten genannten Dienste Dritter.',
        evidence: {
          dragAlternative: 'Das Pipeline-Board lässt sich ohne Drag-and-drop bedienen: jede Karte hat ein Phasen-Auswahlfeld, das den Deal allein mit der Tastatur verschiebt.',
        },
        limitations: {
          thinFixture: 'Der automatische Scan läuft gegen die gemeinsame Codebasis in ihrer Standard-Produktkonfiguration. Ansichten und Texte, die nur {product} zeigt, stehen daher noch nicht unter der automatischen Prüfung.',
        },
      },
      ai: {
        intro: 'Eine Funktion in diesem Produkt sendet Text an ein Sprachmodell eines Drittanbieters. Diese Seite benennt sie, sagt genau, was unseren Server verlässt und was bewusst nicht — und wenn wir etwas noch nicht getan haben, das eine Prüferin gern gesehen hätte, steht auch das hier.',
        tasks: [
          {
            name: 'Vorschlag für die Vertriebszuordnung',
            audience: 'Für Admins, bei der Zuordnung eines Leads zu einem Vertriebsmitarbeiter.',
            sent: 'Fähigkeiten, Position und Interessen eines Leads sowie bis zu fünf Vertriebsmitarbeiter als anonyme Buchstaben A–E mit Fähigkeiten, Interessen und aktueller Auslastung.',
            withheld: 'Sämtliche Namen, E-Mail-Adressen und Kennungen auf beiden Seiten. Die Buchstaben werden erst nach der Antwort auf unserem eigenen Server wieder echten Personen zugeordnet.',
            consent: 'Keine — es wird nichts gesendet, was jemanden identifiziert.',
          },
        ],
        consentBody: 'Die Funktion oben sendet nichts, was jemanden identifiziert, und fragt deshalb niemanden nach einer Einwilligung. Nichts anderes im Produkt hängt an ihr — kein Kernablauf braucht KI, und mit abgeschalteter KI funktioniert alles weiter, was du schon hattest.',
        humanBody: 'Kein Modell setzt eine Pipeline-Stufe, nimmt jemanden an oder lehnt jemanden ab, macht ein Angebot oder ändert ein Konto. Der Zuordnungsvorschlag wird zuerst nach einer einfachen Regel sortiert — gemeinsame Fähigkeiten, dann freie Kapazität — und das Modell ordnet diese kurze Liste nur neu und ergänzt je einen Satz Begründung; lesen und entscheiden tut ein Mensch.',
        retentionBody: 'Weder das Gesendete noch das Zurückkommende wird gespeichert. Erzeugter Text erscheint in deinem Browser und ist beim Neuladen weg. Pro Aufruf speichern wir eine einzige Zeile zur Abrechnung: welche Funktion, wann, welches Konto. Kein Prompt, keine Ausgabe, kein Auszug davon — so lässt sich das Monatslimit zählen, ohne die Daten von irgendjemandem aufzubewahren.',
        notYet: [
          'Für diese Anwendung haben wir keine SOC-2- oder ISO-27001-Zertifizierung.',
          'Mit dem KI-Anbieter haben wir keinen gesonderten Auftragsverarbeitungsvertrag und keine Zero-Retention-Vereinbarung geschlossen; wir nutzen seine veröffentlichten kommerziellen Bedingungen.',
          'Wir können keine Verarbeitungsregion zusichern — Anfragen werden dort verarbeitet, wo der Anbieter sie bedient.',
          'Wir haben keine Evaluation veröffentlicht, die misst, wie treffsicher oder wie verzerrt der Zuordnungsvorschlag ist.',
        ],
      },
      programTemplates: {
        blockers: {
          strandedRelations: 'Einige Leads stehen auf Stufen, die diese Vorlage nicht enthält. Verschieben oder beenden Sie diese zuerst — sonst bleiben sie auf einer Stufe, die es danach nicht mehr gibt.',
        },
        items: {
          canonical_pipeline: {
            name: 'Kanonische Vermittlungs-Pipeline',
          },
          graduate_internship: {
            name: 'Absolventenprogramm',
            desc: 'Bewerbung, Erstgespräch, Zuordnung zu einem Team, das Programm selbst mit Zwischenbewertung und am Ende die Einstellungsentscheidung. Acht Stufen, Fristen und zwei Pflichtdokumente.',
          },
        },
      },
      certificate: {
        title: 'Abschlussdokument',
        signatureTitlePlaceholder: 'z. B. Vertriebsmitarbeiter',
        success: 'Zertifikat erstellt und in den Dokumenten des Leads gespeichert.',
      },
      matchFeedback: {
        reportSubtitle: 'Vorschläge für Vertriebsmitarbeiter der letzten {n} Monate.',
        reportEmpty: 'Noch keine Vorschläge für Vertriebsmitarbeiter erfasst.',
      },
      duplicates: {
        mergeErrors: {
          linked_by_mentorship: 'Diese beiden Datensätze sind über einen Deal verbunden, sind also nicht dieselbe Person. Kläre das zuerst.',
          active_mentor_conflict: 'Beide Datensätze haben einen aktiven Vertriebsmitarbeiter ({a} und {b}). Schließe zuerst einen der beiden Deals, dann führe zusammen — wir entscheiden nicht für dich, welcher Vertriebsmitarbeiter der richtige ist.',
        },
      },
      availability: {
        subtitle: 'Deine wiederkehrenden wöchentlichen Zeitfenster für Lead-Meetings',
        zoneUnset: 'Du hast noch keine Zeitzone gesetzt, daher gelten diese Zeiten als {zone}. Setze deine eigene, damit Leads die richtige Zeit sehen.',
      },
      apiDocs: {
        candidatesHint: 'Gibt bis zu 200 Leads mit aktueller Pipeline-Phase zurück.',
      },
      projects: {
        subtitle: 'Projekte — von Accounts unterstützt oder im Team',
        ownerMentor: 'Ein Vertriebsmitarbeiter',
        ownerMentee: 'Ein Lead',
        members: 'Mitglieder',
        showcaseSubtitle: 'Team- und Account-Projekte.',
        noPublicHint: 'Möchtest du bei einem Projekt mitmachen? Frage deinen Vertriebsmitarbeiter nach Projekten, denen du beitreten kannst.',
        manageOwners: 'Owner & Vertriebsmitarbeiter verwalten',
        roleMentorMember: 'Vertriebsmitarbeiter',
        roleMentee: 'Lead',
        addMenteeMember: 'Lead hinzufügen (mit Rolle)',
        noMenteesToAdd: 'Keine Leads zum Hinzufügen verfügbar.',
      },
      weeklyReports: {
        mentorComment: 'Kommentar des Vertriebsmitarbeiters',
        commentPlaceholder: 'Feedback für den Lead hinzufügen...',
        printDiary: 'Aktivitätstagebuch drucken',
      },
      meetings: {
        topics: [
          'Wöchentliches Check-in',
          'Fortschrittsüberprüfung',
          'Technische Demo',
          'Bedarfsanalyse',
          'Angebotsbesprechung',
          'Feedback-Gespräch',
        ],
        scheduledCount: 'Einladung an {n} Lead(s) gesendet.',
      },
      messageTemplateAdmin: {
        subtitle: 'Die Antworten, die deine Vertriebsmitarbeiter immer wieder schreiben. Einmal verfassen, in den Sprachen, die du brauchst — eingefügt wird sie in der eigenen.',
      },
      orphanApplicants: {
        subtitle: 'Konten, die der öffentliche Bewerbungslink angelegt hat, deren Vertriebsmitarbeiter abgelehnt hat und die kein weiteres Lebenszeichen zeigen. Sie können sich nie anmelden und gehören niemandem, deshalb werden sie {grace} Tage nach der Entscheidung automatisch anonymisiert. Was der Lauf erfassen würde, steht zuerst hier.',
      },
      changeMentor: {
        action: 'Vertriebsmitarbeiter wechseln',
        title: 'Vertriebsmitarbeiter wechseln',
        context: 'Lead: {mentee} · aktueller Vertriebsmitarbeiter: {mentor}',
        hint: 'Ein Schritt, ein Eintrag. Wurde zu diesem Deal noch nichts erfasst, wird der Vertriebsmitarbeiter direkt korrigiert. Gibt es eine Historie, wird der Deal als „Vertriebsmitarbeiter gewechselt“ geschlossen — nie als abgeschlossen — und der neue führt dieselbe Pipeline-Stufe fort. Notizen, Protokolle und Nachrichten bleiben bei dem Deal, unter dem sie entstanden sind.',
        newMentor: 'Neuer Vertriebsmitarbeiter',
        selectNewMentor: 'Neuen Vertriebsmitarbeiter auswählen…',
        privacy: 'Grund und Notiz werden für das Team festgehalten — die Notiz nur im Admin-Audit-Log. In der App bekommt sie keiner der beiden Vertriebsmitarbeiter zu sehen; dem bisherigen wird nur mitgeteilt, dass der Deal beendet ist.',
        submit: 'Vertriebsmitarbeiter wechseln',
        failed: 'Der Vertriebsmitarbeiter konnte nicht gewechselt werden.',
        sameMentor: 'Diese Person ist bereits der Vertriebsmitarbeiter dieses Leads.',
        inactive: 'Dieser Deal ist nicht mehr aktiv — bitte die Seite neu laden.',
        transferredResult: '{mentee} wurde auf derselben Pipeline-Stufe an {mentor} übergeben. Der bisherige Deal ist als „Vertriebsmitarbeiter gewechselt“ geschlossen und behält seine Historie.',
        reasons: {
          mentor_unavailable: 'Der Vertriebsmitarbeiter ist nicht verfügbar',
          changed_goals: 'Der Bedarf des Leads hat sich geändert',
          mentee_request: 'Der Lead hat um einen Wechsel gebeten',
        },
        alreadyMentoredOffer: '{mentor} betreut diese Person bereits. Wechsle den Vertriebsmitarbeiter, statt einen zweiten Deal anzulegen.',
        changeInstead: 'Stattdessen Vertriebsmitarbeiter wechseln',
        badgeReassigned: 'Vertriebsmitarbeiter gewechselt',
      },
      mentorships: {
        title: 'Deals',
        subtitle: 'Leads Vertriebsmitarbeitern und Accounts zuweisen',
        assign: 'Deal zuweisen',
        searchPlaceholder: 'Nach Vertriebsmitarbeiter, Lead oder Account suchen...',
        none: 'Noch keine Deals',
        mentor: 'Vertriebsmitarbeiter',
        mentee: 'Lead',
        selectMentor: 'Vertriebsmitarbeiter auswählen',
        selectMentee: 'Lead auswählen',
        mentorMenteeRequired: 'Vertriebsmitarbeiter und Lead sind erforderlich',
        assignFailed: 'Der Deal konnte nicht erstellt werden.',
        planLimitReached: 'Plangrenze erreicht: {usage}/{limit} aktive Deals im {plan}-Plan. Bestehende Leads sind nicht betroffen — für mehr bitte upgraden.',
        invalidMentor: 'Dieser Vertriebsmitarbeiter kann nicht zugewiesen werden.',
      },
      company: {
        mentor: 'Vertriebsmitarbeiter',
        interestHint: 'Lass den Vertriebsmitarbeiter wissen, wie du über diesen Lead denkst. Er wird benachrichtigt.',
        notePlaceholder: 'Optionale Notiz für den Vertriebsmitarbeiter...',
        interestSaved: 'Gespeichert — der Vertriebsmitarbeiter wurde benachrichtigt.',
        verifiedTitle: 'Vom Vertriebsmitarbeiter verifiziert',
        verifiedHint: 'Bewertungen und Projektarbeit, verifiziert durch den Deal.',
        verifiedEvaluations: 'Bewertungen des Vertriebsmitarbeiters',
      },
      programSurvey: {
        mentee: {
          communication: 'War die Kommunikation mit deiner Ansprechperson da, wenn du sie gebraucht hast?',
        },
        mentor: {
          support: 'War die Unterstützung durch das Team für deine Lead-Betreuung ausreichend?',
          workloadSustainability: 'War dein Aufwand für die Lead-Betreuung in einem nachhaltigen Tempo?',
        },
      },
      surveyTemplates: {
        programPre: {
          q: {
            goalsMentor: 'Was soll dein Lead aus diesem Prozess vor allem mitnehmen?',
          },
        },
        pulse: {
          q: {
            mood: 'Wie läuft der Deal im Moment?',
          },
        },
      },
      relationTimeline: {
        actorRole: {
          MENTOR: 'vom Vertriebsmitarbeiter',
          MENTEE: 'vom Lead',
        },
      },
      erasure: {
        confirmDelete: 'Dies löscht das Konto und seine Deal-Historie endgültig. Kann nicht rückgängig gemacht werden.',
      },
      todos: {
        subtitle: 'Alles auf deiner Liste: was deine Ansprechperson erwartet, was deine Projekte brauchen und was du dir selbst notiert hast.',
      },
      mentorDirectory: {
        title: 'Vertriebsmitarbeiter',
        subtitle: 'Vertriebsmitarbeiter, die gelistet werden möchten — sieh, wer dich betreuen könnte',
        acceptingOnly: 'Nimmt neue Leads an',
        accepting: 'Nimmt Leads an',
        requestMentor: 'Diesen Vertriebsmitarbeiter anfragen',
        requestedMentorUnavailable: 'Dieser Vertriebsmitarbeiter ist nicht mehr verfügbar — wähle unten eine andere Person.',
        selfMatchFullError: 'Diese Person nimmt gerade keine selbst gewählten Leads an — wähle jemand anderen oder lass das Feld leer, dann weist dich ein Admin zu.',
        requestedMentorPending: 'Du hast bereits eine offene Anfrage, deshalb wurde dieser Vertriebsmitarbeiter nicht hinzugefügt.',
        requestedMentorActiveMentorship: 'Du hast bereits einen Vertriebsmitarbeiter, deshalb wurde diese Anfrage nicht gestartet.',
        empty: 'Noch keine Vertriebsmitarbeiter gelistet. Sie erscheinen hier, sobald sie zustimmen.',
        noMatches: 'Keine Vertriebsmitarbeiter passen zu diesen Filtern.',
        loadError: 'Das Verzeichnis der Vertriebsmitarbeiter konnte nicht geladen werden',
        showing: 'Zeige {from}–{to} von {total} Vertriebsmitarbeitern',
        partialNotice: 'Diese Liste ist möglicherweise unvollständig — es konnten nur die ersten {cap} gelisteten Vertriebsmitarbeiter durchsucht werden. Grenze die Filter ein, um sicherzugehen, dass du alle siehst.',
      },
      sourcePortal: {
        title: 'Meine Leads',
        subtitle: 'Reiche von dir vermittelte Leads ein; ein Vertriebsmitarbeiter übernimmt und weist sie zu.',
        addMentee: 'Lead hinzufügen',
        submit: 'Lead einreichen',
        added: 'Lead eingereicht',
        myMentees: 'Eingereichte Leads',
        none: 'Noch keine Leads eingereicht',
        assignedTo: 'Vertriebsmitarbeiter:',
        pending: 'Wartet auf einen Vertriebsmitarbeiter',
      },
      matchScore: {
        dimensions: {
          capacityHeadroom: 'Kapazität des Vertriebsmitarbeiters',
        },
        violations: {
          capacityHeadroom: 'Der Vertriebsmitarbeiter hat keine freie Kapazität mehr',
          managerExclusion: 'Der Vertriebsmitarbeiter ist die direkte Führungskraft dieses Leads',
        },
      },
      demo: {
        roles: {
          mentor: 'Vertriebsmitarbeiter:in',
          mentee: 'Lead',
        },
      },
      testimonials: {
        admin: {
          roles: {
            mentor: 'Vertriebsmitarbeiter',
            mentee: 'Lead',
          },
        },
      },
      tags: {
        notYourMentee: 'Du kannst nur deine eigenen Leads taggen.',
      },
      releaseNotes: {
        feedDescription: 'Neue Funktionen und Verbesserungen in {product}.',
      },
      newsletter: {
        emailMentorTitle: 'Für Vertriebsmitarbeiter',
        audienceMentee: 'Leads',
        audienceMentor: 'Vertriebsmitarbeiter',
        audienceBoth: 'Leads und Vertriebsmitarbeiter',
        audienceHint: 'Vertriebsmitarbeiter sehen zusätzlich den Block "Für Vertriebsmitarbeiter"; Leads nie.',
        mentorNote: 'Für Vertriebsmitarbeiter',
        mentorNotePlaceholder: 'Was ein Vertriebsmitarbeiter mit diesem Inhalt tun sollte.',
        mentorNoteHint: 'Wird nur Vertriebsmitarbeitern gezeigt, und nur bei Vertriebs- oder gemeinsamen Ausgaben.',
        previewAsMentee: 'Lead',
        previewAsMentor: 'Vertriebsmitarbeiter',
        archiveMentorNote: 'Für Vertriebsmitarbeiter',
      },
      modeSwitch: {
        mentor: 'Vertriebsmitarbeiter',
        mentee: 'Lead',
        mentorHint: 'Vertriebs-Ansicht: nur die Leads, die du selbst betreust.',
        menteeHint: 'Lead-Ansicht: dein eigener Deal — der, in dem du der Lead bist.',
      },
      menteeActivation: {
        placeholderNote: 'Dieser Lead wurde ohne E-Mail-Adresse angelegt, hat deshalb eine Platzhalteradresse und kann sich nicht anmelden. Trage die echte Adresse ein, um das Konto zu aktivieren — der Datensatz, das Interaktionsprotokoll und die Phasenhistorie bleiben erhalten.',
        noPasswordNote: 'Dieser Lead hat noch kein Passwort gesetzt. Korrigiere die Adresse, falls sie falsch ist, und sende den Aktivierungslink erneut.',
        mailFailedHint: 'Die E-Mail konnte nicht gesendet werden. Teile diesen Link direkt mit dem Lead:',
      },
      onboarding: {
        mentee: {
          subtitle: 'Hilf uns, dich mit der passenden Ansprechperson und den richtigen Angeboten zusammenzubringen',
        },
        mentor: {
          title: 'Richte dein Vertriebsprofil ein',
          subtitle: 'Ein paar kurze Schritte, damit Leads wissen, wer du bist und wann du verfügbar bist',
        },
      },
      stageClock: {
        mentee: {
          expectedBy: 'Deine Ansprechperson plant den nächsten Schritt bis zum {date}.',
          reassure: 'Wartezeiten unterscheiden sich von Phase zu Phase — wenn du ein Update möchtest, frag einfach deine Ansprechperson.',
        },
      },
      evaluation: {
        titleMentor: 'Bewerte deinen Vertriebsmitarbeiter',
        onMentor: 'Über Vertriebsmitarbeiter',
      },
      profileForm: {
        mentorCapacity: 'Lead-Kapazität',
        mentorCapacityHint: 'Wie viele Leads du gleichzeitig betreuen kannst',
      },
      aiSummary: {
        consentRequired: 'Der Lead hat KI-Zusammenfassungen nicht erlaubt. Aktivierbar unter Konto → Datenschutz & Einwilligung.',
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

/** Values the overlay's own placeholders are filled with while it is merged. */
export interface OverlayFill {
  /** The product name `{product}` stands for — the caller's resolved brand. */
  product?: string;
}

/** The placeholder an overlay uses for the product name (filled by applyVerticalOverlay). */
export const PRODUCT_PLACEHOLDER = '{product}';

// Fill `{product}` in every string of an overlay subtree (arrays included — an
// overlay replaces an array whole). split/join rather than replace(): a brand
// name is data, and a `$&` in it must print as written.
function fillOverlay<T>(node: T, product: string): T {
  if (typeof node === 'string') return node.split(PRODUCT_PLACEHOLDER).join(product) as unknown as T;
  if (Array.isArray(node)) return node.map((n) => fillOverlay(n, product)) as unknown as T;
  if (isPlainObject(node)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = fillOverlay(v, product);
    return out as T;
  }
  return node;
}

// Apply a vertical's overlay to an already-resolved base dictionary. Returns the
// base unchanged when the vertical overrides nothing for this locale — so the
// INTERNSHIP path and every not-yet-dressed locale cost nothing and stay
// referentially identical.
//
// `fill.product` fills the overlay's `{product}` — in the OVERLAY's strings
// only: a base string's `{product}` (wrongWorld, the mail subjects, …) is left
// for the code that renders it, exactly as before. Without it the token stays
// as written, which is what a structural check (check-i18n, the unit spec)
// wants; every renderer passes it.
export function applyVerticalOverlay<T extends object>(
  base: T,
  locale: Locale,
  vertical: VerticalKey | null | undefined,
  fill?: OverlayFill,
): T {
  const v = vertical ?? DEFAULT_VERTICAL;
  if (v === DEFAULT_VERTICAL || !hasOverlay(v, locale)) return base;
  const overlay = fill?.product !== undefined ? filledOverlay(v, locale, fill.product) : OVERLAYS[v][locale];
  return deepMerge(base, overlay as DeepPartial<T>);
}

// A filled overlay is the same for every request of one vertical, locale and
// product name, so it is built once. Bounded: product names are per
// organization, and an evicted entry is merely rebuilt.
const FILLED_MAX = 64;
const filled = new Map<string, LocaleOverlay>();
function filledOverlay(vertical: VerticalKey, locale: Locale, product: string): LocaleOverlay {
  const key = `${vertical}\u0000${locale}\u0000${product}`;
  let hit = filled.get(key);
  if (!hit) {
    if (filled.size >= FILLED_MAX) filled.delete(filled.keys().next().value as string);
    hit = fillOverlay(OVERLAYS[vertical][locale], product);
    filled.set(key, hit);
  }
  return hit;
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
