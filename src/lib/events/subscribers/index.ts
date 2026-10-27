// Every domain-event subscriber in the product, registered once (#1693).
// `emit()` reads this to decide which deliveries to enqueue, and the
// `event.deliver` job reads it to find the handler by name.
import { registerSubscriber } from '../subscribers';
import { webhookSubscriber } from './webhook';
import { configAuditSubscriber } from './configAudit';

let registered = false;

export function registerAllSubscribers(): void {
  if (registered) return;
  registered = true;
  registerSubscriber(webhookSubscriber);
  registerSubscriber(configAuditSubscriber);
}
