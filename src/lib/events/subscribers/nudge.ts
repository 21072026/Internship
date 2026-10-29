// The nudge subscriber (#1684): an allowlisted NON-stage event → the org's
// enabled event-triggered NudgeRules (src/lib/nudges/). `pipeline.stage_change`
// is never in its list — stage-triggered rules are the automation subscriber's
// (#1703). The evaluator is imported lazily, like the automation subscriber's,
// so loading the registry never pulls mail into every producer's module graph.
// Rerun-safe: each send job is keyed (rule, person, `evt:<eventId>`) and the
// NudgeSend row is unique on the same triple.
import type { SubscriberDefinition } from '../subscribers';
import { NUDGE_EVENT_TRIGGERS } from '@/lib/nudges/rule';

export const nudgeSubscriber: SubscriberDefinition = {
  name: 'nudge',
  events: NUDGE_EVENT_TRIGGERS,
  handle: async (event) => {
    const { evaluateNudgeEvent } = await import('@/lib/nudges/evaluate');
    await evaluateNudgeEvent(event);
  },
};
