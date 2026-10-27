// The stage-automation subscriber (#1703): `pipeline.stage_change` → the org's
// enabled AutomationRules for that move (src/lib/automation/). The evaluator is
// imported lazily so loading the registry (which `emit()` does) never pulls the
// action handlers — mail, notifications, goals — into every producer's module
// graph. Rerun-safe: AutomationRun is unique on (ruleId, eventId), so a
// redelivered event creates no second run (src/lib/automation/engine.ts).
import type { SubscriberDefinition } from '../subscribers';
import { AUTOMATION_SUBSCRIBER, STAGE_CHANGE_EVENT } from '@/lib/automation/engine';

export const automationSubscriber: SubscriberDefinition = {
  name: AUTOMATION_SUBSCRIBER,
  events: [STAGE_CHANGE_EVENT],
  handle: async (event) => {
    const { evaluateAutomationEvent } = await import('@/lib/automation/evaluate');
    await evaluateAutomationEvent(event);
  },
};
