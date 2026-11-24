/** Stable public conversion identifiers: renaming splits historical funnels (#1388). */
export const ANALYTICS_EVENTS = {
  SIGNUP_COMPLETED: 'signup_completed',
  SIGNUP_VERIFIED: 'signup_verified',
  MENTOR_APPLICATION_SUBMITTED: 'mentor_application_submitted',
  COMPANY_INQUIRY_SUBMITTED: 'company_inquiry_submitted',
  DEMO_CTA_CLICK: 'demo_cta_click', // Preserve the shipped #1391 identifier.
  ROLE_CARD_SELECTED: 'role_card_selected',
  FEATURES_VIEWED: 'features_viewed',
  PRICING_VIEWED: 'pricing_viewed',
} as const;
export type AnalyticsEvent = typeof ANALYTICS_EVENTS[keyof typeof ANALYTICS_EVENTS];

// This CRM holds people's identities and private case notes. Generic string
// properties make accidental disclosure effortless. Only finite, code-owned
// UI categories are allowed: never form values, URLs, names, contact data or IDs.
export type EventProps = {
  role?: 'mentee' | 'mentor' | 'company';
  placement?: 'hero' | 'cta' | 'footer' | 'features';
};
export type ExactEventProps<P extends EventProps> = P & {
  [K in Exclude<keyof P, keyof EventProps>]: never;
};

/** Runtime defence for JavaScript callers/casts; rebuild, never spread caller data. */
export function safeEventProps(props: EventProps): EventProps {
  const safe: EventProps = {};
  const { role, placement } = props;
  if (role === 'mentee' || role === 'mentor' || role === 'company') safe.role = role;
  if (placement === 'hero' || placement === 'cta' || placement === 'footer' || placement === 'features') safe.placement = placement;
  return safe;
}

/** Loader lifecycle only, not an event sent to vendors. */
export const ANALYTICS_READY_EVENT = 'analyticsproviderready';
