// The chat interaction entry (#1948): the dispatcher with every built-in
// action registered. Routes import from here, never from dispatch.ts directly,
// so no request can reach a registry that is still empty.
import './actions';

export { dispatchInteraction, registeredChatActions } from './dispatch';
export type { DispatchOutcome, ChatReply } from './dispatch';
export { parseSlackInteraction, parseTeamsInteraction, isTeamsInteraction, isSlackResponseUrl } from './envelope';
