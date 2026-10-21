// The app's native menu (#2775): the person's web sidebar, as
// GET /api/app/navigation returns it (src/lib/appNavigation.ts on the server —
// the same list, filter and labels as the web). Only the icon is chosen here,
// by the link's key. Dependency-free so `npm test` pins it.

export interface MenuItem {
  key: string;
  href: string;
  label: string;
}

/** Ionicons glyph per nav key (`t.nav` keys in navLinks.ts); unknown keys get a neutral one. */
const ICONS: Record<string, string> = {
  dashboard: 'grid',
  board: 'albums',
  companies: 'business',
  myCompanies: 'business',
  hiring: 'file-tray-full',
  requisitions: 'briefcase',
  offers: 'ribbon',
  interviewRequests: 'calendar',
  interviewPanels: 'clipboard',
  candidates: 'people',
  duplicates: 'git-merge',
  mentors: 'person-add',
  mentorships: 'people-circle',
  health: 'pulse',
  mentorApplications: 'school',
  companyInquiries: 'mail-unread',
  myProfile: 'person-circle',
  profile: 'person-circle',
  projects: 'folder-open',
  mentorDirectory: 'people',
  todos: 'checkbox',
  messages: 'chatbubbles',
  interactionLogs: 'book',
  interactions: 'book',
  myNotes: 'lock-closed',
  insights: 'bulb',
  myInsights: 'analytics',
  newsletters: 'newspaper',
  mentees: 'people',
  availability: 'time',
  calendar: 'calendar',
  menteeActivity: 'pulse',
  analytics: 'bar-chart',
  feedback: 'chatbox-ellipses',
  settings: 'settings',
  acquisition: 'mail',
  activity: 'pulse',
  agreements: 'document-lock',
  announcements: 'megaphone',
  apiExplorer: 'code-slash',
  applications: 'document-text',
  cohorts: 'layers',
  contributorTerms: 'document-lock',
  documents: 'document',
  email: 'mail',
  goalTemplates: 'list',
  integrations: 'git-network',
  rosterFeeds: 'sync',
  invitations: 'mail-open',
  invite: 'person-add',
  inviteMentee: 'person-add',
  meetings: 'videocam',
  messageTemplates: 'chatbox',
  migrate: 'cloud-upload',
  agendaTemplates: 'list-circle',
  safeguarding: 'shield-checkmark',
  aiConsole: 'sparkles',
  slaQueue: 'alarm',
  myMentees: 'people',
  billing: 'receipt',
  organizations: 'business',
  orgAttributes: 'options',
  outbox: 'paper-plane',
  reEngagement: 'refresh',
  reportSubscriptions: 'mail-unread',
  reportsExplorer: 'stats-chart',
  retention: 'shield-checkmark',
  skills: 'sparkles',
  sources: 'radio',
  support: 'help-buoy',
  surveys: 'clipboard',
  tags: 'pricetag',
  testimonials: 'chatbox-ellipses',
  users: 'person',
  weeklyReportsAdmin: 'calendar',
};

export function menuIcon(key: string): string {
  return ICONS[key] ?? 'ellipse-outline';
}

/** Destinations the app already has as a native tab, so the menu does not list them twice. */
export const NATIVE_TABS = new Set(['/messages', '/todos', '/notifications']);

export function menuItems(items: MenuItem[]): MenuItem[] {
  return items.filter((i) => i.href.startsWith('/') && !i.href.startsWith('//') && !NATIVE_TABS.has(i.href));
}
