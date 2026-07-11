// Single source of truth for the product's feature catalogue (#584/#587).
// Both the landing page cards (featured subset) and the /features catalogue
// page read from here — update THIS list when a new feature ships (see the
// convention in CLAUDE.md, next to the changelog/releaseNotes discipline).
//
// Titles/descriptions live in the i18n dictionary: the nine original landing
// features keep their `landing.f*` keys (several e2e specs assert those exact
// strings), newer entries use the `featureCatalog` block. Both namespaces are
// server-only, so consumers must be server components (landing and /features
// both are).

import type { LucideIcon } from 'lucide-react';
import {
  GitBranch, Users, Building2, CalendarClock, FileText, Target,
  BarChart3, ShieldCheck, Sparkles, MessageCircle, Activity,
  Search, Bot, KeyRound, UserPlus,
} from 'lucide-react';
import type { Dictionary } from '@/i18n/dictionaries';

export type FeatureCategory = 'tracking' | 'collaboration' | 'companies' | 'insights' | 'trust' | 'platform';

export interface Feature {
  key: string;
  category: FeatureCategory;
  icon: LucideIcon;
  color: string;
  // Featured entries render as the landing page's feature cards.
  featured?: boolean;
  title: string;
  desc: string;
}

export const FEATURE_CATEGORIES: FeatureCategory[] = [
  'tracking', 'collaboration', 'companies', 'insights', 'trust', 'platform',
];

// Resolved against the server dictionary so both pages localize identically.
export function getFeatures(t: Dictionary): Feature[] {
  const L = t.landing;
  const C = t.featureCatalog.items;
  return [
    // Featured (the original landing cards — exact strings asserted in e2e).
    { key: 'pipeline', category: 'tracking', icon: GitBranch, color: 'blue', featured: true, title: L.fPipelineT, desc: L.fPipelineD },
    { key: 'mentors', category: 'collaboration', icon: Users, color: 'green', featured: true, title: L.fMentorT, desc: L.fMentorD },
    { key: 'companies', category: 'companies', icon: Building2, color: 'purple', featured: true, title: L.fCompanyT, desc: L.fCompanyD },
    { key: 'comms', category: 'collaboration', icon: CalendarClock, color: 'amber', featured: true, title: L.fCommsT, desc: L.fCommsD },
    { key: 'docs', category: 'platform', icon: FileText, color: 'teal', featured: true, title: L.fDocsT, desc: L.fDocsD },
    { key: 'growth', category: 'collaboration', icon: Target, color: 'orange', featured: true, title: L.fGrowthT, desc: L.fGrowthD },
    { key: 'analytics', category: 'insights', icon: BarChart3, color: 'sky', featured: true, title: L.fAnalyticsT, desc: L.fAnalyticsD },
    { key: 'privacy', category: 'trust', icon: ShieldCheck, color: 'rose', featured: true, title: L.fPrivacyT, desc: L.fPrivacyD },
    { key: 'platform', category: 'platform', icon: Sparkles, color: 'indigo', featured: true, title: L.fPlatformT, desc: L.fPlatformD },
    // Catalogue-only (newer features; strings in featureCatalog.items).
    { key: 'messaging', category: 'collaboration', icon: MessageCircle, color: 'blue', title: C.messaging.t, desc: C.messaging.d },
    { key: 'activityReport', category: 'insights', icon: Activity, color: 'green', title: C.activityReport.t, desc: C.activityReport.d },
    { key: 'talentPool', category: 'companies', icon: Search, color: 'purple', title: C.talentPool.t, desc: C.talentPool.d },
    { key: 'aiPackage', category: 'insights', icon: Bot, color: 'indigo', title: C.aiPackage.t, desc: C.aiPackage.d },
    { key: 'security', category: 'trust', icon: KeyRound, color: 'amber', title: C.security.t, desc: C.security.d },
    { key: 'selfServe', category: 'tracking', icon: UserPlus, color: 'teal', title: C.selfServe.t, desc: C.selfServe.d },
  ];
}
