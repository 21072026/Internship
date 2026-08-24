import {
  Bell,
  Clock,
  UserCheck,
  Target,
  MessageCircle,
  FileText,
  FolderKanban,
  UserPlus,
  HelpCircle,
  LifeBuoy,
  Handshake,
  Milestone,
  UserCog,
  CalendarClock,
  Megaphone,
  GraduationCap,
  type LucideIcon,
} from 'lucide-react';

// One icon per Notification.type value (free-form string, see prisma/schema.prisma) —
// shared between the bell dropdown and the /notifications history page so both
// surfaces agree on what each notification type looks like.
const NOTIFICATION_TYPE_ICONS: Record<string, LucideIcon> = {
  deadline: Clock,
  retention: UserCheck,
  need_match: Target,
  message: MessageCircle,
  application: FileText,
  project: FolderKanban,
  signup: UserPlus,
  question: HelpCircle,
  support: LifeBuoy,
  mentorship_request: Handshake,
  stage: Milestone,
  impersonation: UserCog,
  meeting_request: CalendarClock,
  announcement: Megaphone,
  mentor_application: GraduationCap,
  interaction: FileText,
  meeting: CalendarClock,
  goal: Target,
  evaluation: UserCheck,
  company_interest: Handshake,
};

export function NotificationTypeIcon({ type, className }: { type: string; className?: string }) {
  // i18n event keys are dotted ("message.new"); the icon is per category, so
  // fall back to the first segment before the generic bell.
  const Icon = NOTIFICATION_TYPE_ICONS[type] ?? NOTIFICATION_TYPE_ICONS[type.split('.')[0]] ?? Bell;
  return <Icon className={className} aria-hidden="true" />;
}
