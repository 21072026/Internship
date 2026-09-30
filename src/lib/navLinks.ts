import {
  Activity, BarChart3, BookOpen, Braces, BriefcaseBusiness, Building2, CalendarClock, CalendarDays,
  CalendarRange, ClipboardCheck, ClipboardList, Columns3, FileSignature, FileText, FolderGit2,
  FolderKanban, GitMerge, GraduationCap, Inbox, Layers, LayoutDashboard, LifeBuoy, ListChecks, Lock,
  Handshake, Mail, MailCheck, MailOpen, Megaphone, MessageSquare, MessageSquareQuote, MessageSquareText, Network, Quote, Radio,
  ScrollText, Settings, ShieldCheck, Tag as TagIcon, User, UserCheck, UserCog, UserPlus, Users, Video,
  Webhook,
  type LucideIcon,
} from 'lucide-react';
import type { VerticalCapability } from '@/lib/verticals';

/**
 * The single source of truth for the role sidebars — and, because of that, for
 * the command palette's "Go to" group (#2079). The palette used to be specified
 * as "copy the routes out of the nav components"; a copy drifts the first time a
 * page is added, and a drifted copy is exactly the bug the issue calls out (an
 * entry that leads somewhere the role is refused). One list, three readers.
 *
 * `key` indexes `t.nav`; `exact` marks a role's root so it isn't permanently
 * active. These are *presentation* only — every destination stays guarded by its
 * own layout/handler, and the palette is never the access control.
 */
export interface NavLink {
  href: string;
  icon: LucideIcon;
  /** Key into the `nav` i18n namespace. */
  key: string;
  exact?: boolean;
  /**
   * The vertical capability this destination belongs to (#2351). A link with a
   * capability is shown only to an org whose vertical carries it; an untagged
   * link is shown to every vertical. INTERNSHIP carries every capability, so no
   * tag ever hides a link there — the filter is a no-op for today's product.
   * Only the unambiguous cases are tagged; fuzzier ones stay untagged (shown)
   * until a later refinement decides them deliberately.
   */
  capability?: VerticalCapability;
}

export const ADMIN_NAV_LINKS: NavLink[] = [
  { href: '/admin', icon: LayoutDashboard, key: 'dashboard', exact: true },
  { href: '/admin/board', icon: Columns3, key: 'board' },
  { href: '/admin/companies', icon: Building2, key: 'companies' },
  { href: '/admin/requisitions', icon: BriefcaseBusiness, key: 'requisitions' , capability: 'placements' },
  { href: '/admin/offers', icon: Handshake, key: 'offers' , capability: 'placements' },
  { href: '/admin/interview-requests', icon: CalendarDays, key: 'interviewRequests' , capability: 'placements' },
  { href: '/interviews', icon: ClipboardCheck, key: 'interviewPanels' , capability: 'placements' },
  { href: '/admin/candidates', icon: Users, key: 'candidates' },
  { href: '/admin/duplicates', icon: GitMerge, key: 'duplicates' },
  { href: '/admin/mentors', icon: UserCheck, key: 'mentors' , capability: 'mentorship' },
  { href: '/admin/mentorship', icon: Users, key: 'mentorships' , capability: 'mentorship' },
  { href: '/admin/mentor-applications', icon: GraduationCap, key: 'mentorApplications' , capability: 'mentorship' },
  // The enquiry inbox is shared since #2569: on an internship tenant it holds the
  // /for-companies enquiries, on a MARKETING tenant the landing's demo requests
  // (and is the "unowned leads" list, #2580) — both are the `companies` module.
  { href: '/admin/company-inquiries', icon: Building2, key: 'companyInquiries', capability: 'companies' },
  // Intern team/task projects and their contributor-IP terms, mentee goal
  // templates, programme cohorts and mentor/mentee success stories are
  // internship modules (#2499). A MARKETING
  // tenant carries none of these capabilities, so the links drop out of its
  // sidebar — and the projects write APIs are gated on the same capability.
  { href: '/admin/projects', icon: FolderGit2, key: 'projects', capability: 'projects' },
  { href: '/admin/goal-templates', icon: ListChecks, key: 'goalTemplates', capability: 'mentorship' },
  // The canned-response pool the composer offers (#1871), next to the other
  // reusable-text screen rather than buried under settings.
  { href: '/admin/message-templates', icon: MessageSquareQuote, key: 'messageTemplates' },
  { href: '/todos', icon: ClipboardList, key: 'todos' },
  { href: '/admin/cohorts', icon: Layers, key: 'cohorts', capability: 'mentorship' },
  { href: '/admin/tags', icon: TagIcon, key: 'tags' },
  { href: '/admin/sources', icon: Radio, key: 'sources' , capability: 'sourcing' },
  { href: '/admin/users', icon: UserCog, key: 'users' },
  { href: '/admin/meetings', icon: Video, key: 'meetings' },
  { href: '/admin/calendar', icon: CalendarDays, key: 'calendar' },
  { href: '/admin/announcements', icon: Megaphone, key: 'announcements' },
  // The newsletter is career content for MENTEE/MENTOR audiences (#1469): an
  // internship module. Tagged `mentorship` rather than a new `newsletter`
  // capability — its audiences only exist where mentorship does, and a second
  // key that always travels with the first is a key that can only drift.
  // Tagging also closes the URL (pageCapabilityGate) and the APIs gate on it.
  { href: '/admin/newsletters', icon: MailOpen, key: 'newsletters', capability: 'mentorship' },
  { href: '/admin/testimonials', icon: Quote, key: 'testimonials', capability: 'mentorship' },
  // "E-mail your mentees" — addressed through mentorship relations.
  { href: '/admin/email', icon: Mail, key: 'email', capability: 'mentorship' },
  { href: '/admin/documents', icon: FileText, key: 'documents' },
  { href: '/admin/support', icon: LifeBuoy, key: 'support' },
  { href: '/admin/activity', icon: ScrollText, key: 'activity' },
  { href: '/admin/mentee-activity', icon: Activity, key: 'menteeActivity' , capability: 'mentorship' },
  { href: '/admin/analytics', icon: BarChart3, key: 'analytics' },
  { href: '/admin/integrations', icon: Webhook, key: 'integrations' },
  { href: '/admin/api-explorer', icon: Braces, key: 'apiExplorer' },
  { href: '/admin/retention', icon: ShieldCheck, key: 'retention' },
  // Re-engaging dormant applicants/mentees is the internship funnel's tail.
  { href: '/admin/re-engagement', icon: UserPlus, key: 'reEngagement', capability: 'mentorship' },
  { href: '/admin/contributor-terms', icon: FileSignature, key: 'contributorTerms', capability: 'projects' },
  { href: '/admin/organizations', icon: Network, key: 'organizations' },
  { href: '/admin/settings', icon: Settings, key: 'settings' },
  { href: '/admin/invite', icon: Mail, key: 'invite' },
  // The board that answers "who actually joined?" (#2071), next to the page
  // that sends the invitations in the first place.
  { href: '/admin/invitations', icon: MailCheck, key: 'invitations' },
];

export const MENTOR_NAV_LINKS: NavLink[] = [
  { href: '/mentor', icon: LayoutDashboard, key: 'dashboard', exact: true },
  { href: '/mentor/board', icon: Columns3, key: 'board' },
  { href: '/mentor/mentees', icon: Users, key: 'myMentees' },
  { href: '/mentor/applications', icon: Inbox, key: 'applications' },
  { href: '/mentor/invite', icon: UserPlus, key: 'inviteMentee' },
  { href: '/mentor/profile', icon: User, key: 'myProfile' },
  { href: '/mentor/projects', icon: FolderGit2, key: 'projects', capability: 'projects' },
  { href: '/todos', icon: ClipboardList, key: 'todos' },
  { href: '/mentor/interactions', icon: BookOpen, key: 'interactionLogs' },
  { href: '/mentor/email', icon: Mail, key: 'email' },
  { href: '/mentor/meetings', icon: CalendarClock, key: 'meetings' },
  { href: '/mentor/interview-requests', icon: CalendarDays, key: 'interviewRequests' },
  { href: '/interviews', icon: ClipboardCheck, key: 'interviewPanels' },
  { href: '/mentor/availability', icon: CalendarRange, key: 'availability' },
  { href: '/mentor/calendar', icon: CalendarDays, key: 'calendar' },
  { href: '/mentor/mentee-activity', icon: Activity, key: 'menteeActivity' },
  { href: '/mentor/analytics', icon: BarChart3, key: 'analytics' },
  { href: '/mentor/feedback', icon: MessageSquareText, key: 'feedback' },
  // Mentors read the same archive; a shared issue shows them its coaching
  // block, exactly as the e-mail does (#1469).
  { href: '/newsletters', icon: MailOpen, key: 'newsletters', capability: 'mentorship' },
];

export const PORTAL_NAV_LINKS: NavLink[] = [
  { href: '/portal', icon: LayoutDashboard, key: 'dashboard', exact: true },
  { href: '/portal/profile', icon: User, key: 'myProfile' },
  // Their own projects, not the public showcase at /projects (#1114).
  { href: '/portal/projects', icon: FolderKanban, key: 'projects', capability: 'projects' },
  // Opted-in mentors only (#938) — consent-gated, see /api/mentors.
  { href: '/mentors', icon: Users, key: 'mentorDirectory' },
  { href: '/todos', icon: ListChecks, key: 'todos' },
  // The shared inbox, not a portal-only copy of it (#1156).
  { href: '/messages', icon: MessageSquare, key: 'messages' },
  { href: '/portal/interactions', icon: BookOpen, key: 'interactionLogs' },
  { href: '/portal/notes', icon: Lock, key: 'myNotes' },
  // Their own copy of the activity report their mentor and admin already
  // read about them (#1915) — transparency, not a scoreboard.
  { href: '/portal/insights', icon: Activity, key: 'myInsights' },
  // The career-tips archive (#1469). Linked from the sidebar and not only
  // from the e-mail footer: the issues stay useful long after the mail is
  // gone, and someone who unsubscribed can still read them here.
  { href: '/newsletters', icon: MailOpen, key: 'newsletters', capability: 'mentorship' },
];

/**
 * The sales surface (#2580): a MENTOR of a vertical without `mentorship` works
 * on /sales — see src/lib/salesSurface.ts for who gets it and why. Every link is
 * tagged with the module it shows, so a vertical that lacked one would lose the
 * link; MARKETING carries both. Not a `NavRole`: the palette's "Go to" group
 * belongs to the three role shells, and this shell mounts no palette.
 */
export const SALES_NAV_LINKS: NavLink[] = [
  { href: '/sales', icon: LayoutDashboard, key: 'dashboard', exact: true, capability: 'pipeline' },
  { href: '/sales/board', icon: Columns3, key: 'board', capability: 'pipeline' },
  { href: '/sales/accounts', icon: Building2, key: 'myCompanies', capability: 'companies' },
];

/** Roles that get a sidebar (and therefore a "Go to" group in the palette). */
export type NavRole = 'ADMIN' | 'MENTOR' | 'MENTEE';

export function navLinksForRole(role: NavRole): NavLink[] {
  if (role === 'ADMIN') return ADMIN_NAV_LINKS;
  if (role === 'MENTOR') return MENTOR_NAV_LINKS;
  return PORTAL_NAV_LINKS;
}

/**
 * Drop the links a vertical does not carry (#2351). A link with no `capability`
 * is always kept; a tagged one survives only when `caps` includes it. Passing
 * the full capability set — which INTERNSHIP always has — keeps every link, so
 * this is a no-op for today's product and only thins the sidebar for a vertical
 * that switches a module off (e.g. MARKETING has no `mentorship`, so the mentor
 * and mentorship links fall away). Pure: same inputs, same array, no I/O.
 */
export function visibleNavLinks(
  links: NavLink[],
  caps: readonly VerticalCapability[],
): NavLink[] {
  return links.filter((l) => !l.capability || caps.includes(l.capability));
}
