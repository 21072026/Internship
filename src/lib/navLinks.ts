import {
  Activity, BarChart3, BookOpen, Braces, BriefcaseBusiness, Building2, CalendarClock, CalendarDays,
  CalendarRange, ClipboardCheck, ClipboardList, Columns3, FileSignature, FileText, FolderGit2,
  FolderKanban, GitMerge, GraduationCap, Inbox, Layers, LayoutDashboard, LifeBuoy, ListChecks, Lock,
  Handshake, Mail, MailCheck, MailOpen, Megaphone, MessageSquare, MessageSquareText, Network, Quote, Radio,
  ScrollText, Settings, ShieldCheck, Tag as TagIcon, User, UserCheck, UserCog, UserPlus, Users, Video,
  Webhook,
  type LucideIcon,
} from 'lucide-react';

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
}

export const ADMIN_NAV_LINKS: NavLink[] = [
  { href: '/admin', icon: LayoutDashboard, key: 'dashboard', exact: true },
  { href: '/admin/board', icon: Columns3, key: 'board' },
  { href: '/admin/companies', icon: Building2, key: 'companies' },
  { href: '/admin/requisitions', icon: BriefcaseBusiness, key: 'requisitions' },
  { href: '/admin/offers', icon: Handshake, key: 'offers' },
  { href: '/admin/interview-requests', icon: CalendarDays, key: 'interviewRequests' },
  { href: '/interviews', icon: ClipboardCheck, key: 'interviewPanels' },
  { href: '/admin/candidates', icon: Users, key: 'candidates' },
  { href: '/admin/duplicates', icon: GitMerge, key: 'duplicates' },
  { href: '/admin/mentors', icon: UserCheck, key: 'mentors' },
  { href: '/admin/mentorship', icon: Users, key: 'mentorships' },
  { href: '/admin/mentor-applications', icon: GraduationCap, key: 'mentorApplications' },
  { href: '/admin/company-inquiries', icon: Building2, key: 'companyInquiries' },
  { href: '/admin/projects', icon: FolderGit2, key: 'projects' },
  { href: '/admin/goal-templates', icon: ListChecks, key: 'goalTemplates' },
  { href: '/todos', icon: ClipboardList, key: 'todos' },
  { href: '/admin/cohorts', icon: Layers, key: 'cohorts' },
  { href: '/admin/tags', icon: TagIcon, key: 'tags' },
  { href: '/admin/sources', icon: Radio, key: 'sources' },
  { href: '/admin/users', icon: UserCog, key: 'users' },
  { href: '/admin/meetings', icon: Video, key: 'meetings' },
  { href: '/admin/calendar', icon: CalendarDays, key: 'calendar' },
  { href: '/admin/announcements', icon: Megaphone, key: 'announcements' },
  { href: '/admin/newsletters', icon: MailOpen, key: 'newsletters' },
  { href: '/admin/testimonials', icon: Quote, key: 'testimonials' },
  { href: '/admin/email', icon: Mail, key: 'email' },
  { href: '/admin/documents', icon: FileText, key: 'documents' },
  { href: '/admin/support', icon: LifeBuoy, key: 'support' },
  { href: '/admin/activity', icon: ScrollText, key: 'activity' },
  { href: '/admin/mentee-activity', icon: Activity, key: 'menteeActivity' },
  { href: '/admin/analytics', icon: BarChart3, key: 'analytics' },
  { href: '/admin/integrations', icon: Webhook, key: 'integrations' },
  { href: '/admin/api-explorer', icon: Braces, key: 'apiExplorer' },
  { href: '/admin/retention', icon: ShieldCheck, key: 'retention' },
  { href: '/admin/re-engagement', icon: UserPlus, key: 'reEngagement' },
  { href: '/admin/contributor-terms', icon: FileSignature, key: 'contributorTerms' },
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
  { href: '/mentor/projects', icon: FolderGit2, key: 'projects' },
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
  { href: '/newsletters', icon: MailOpen, key: 'newsletters' },
];

export const PORTAL_NAV_LINKS: NavLink[] = [
  { href: '/portal', icon: LayoutDashboard, key: 'dashboard', exact: true },
  { href: '/portal/profile', icon: User, key: 'myProfile' },
  // Their own projects, not the public showcase at /projects (#1114).
  { href: '/portal/projects', icon: FolderKanban, key: 'projects' },
  // Opted-in mentors only (#938) — consent-gated, see /api/mentors.
  { href: '/mentors', icon: Users, key: 'mentorDirectory' },
  { href: '/todos', icon: ListChecks, key: 'todos' },
  // The shared inbox, not a portal-only copy of it (#1156).
  { href: '/messages', icon: MessageSquare, key: 'messages' },
  { href: '/portal/interactions', icon: BookOpen, key: 'interactionLogs' },
  { href: '/portal/notes', icon: Lock, key: 'myNotes' },
  // The career-tips archive (#1469). Linked from the sidebar and not only
  // from the e-mail footer: the issues stay useful long after the mail is
  // gone, and someone who unsubscribed can still read them here.
  { href: '/newsletters', icon: MailOpen, key: 'newsletters' },
];

/** Roles that get a sidebar (and therefore a "Go to" group in the palette). */
export type NavRole = 'ADMIN' | 'MENTOR' | 'MENTEE';

export function navLinksForRole(role: NavRole): NavLink[] {
  if (role === 'ADMIN') return ADMIN_NAV_LINKS;
  if (role === 'MENTOR') return MENTOR_NAV_LINKS;
  return PORTAL_NAV_LINKS;
}
