// Opening the lead page's interaction form from elsewhere on the page (#3737):
// "Complete follow-up" (#3740), a click on the phone or e-mail link (#3741) and
// the N shortcut (#3742) all ask the one form in SalesInteractionsCard to open,
// pre-set. A window event, not a shared React context: the asking parts sit in
// different client islands of a server-rendered page. Nothing is saved — the
// rep still presses the form's own button.

import type { InteractionType } from '@/lib/interactionTypes';

export const INTERACTION_DRAFT_EVENT = 'sales-lead:interaction-draft';

export interface InteractionDraftRequest {
  type?: InteractionType;
  notes?: string;
  /**
   * Runs once the interaction this draft opened is SAVED — never on Cancel, and
   * not when another draft replaces this one first. "Complete follow-up" clears
   * the follow-up here (#3803): clearing it on the click lost it whenever the rep
   * changed their mind and cancelled the form.
   */
  onLogged?: () => unknown;
}

export function openInteractionDraft(draft: InteractionDraftRequest = {}): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<InteractionDraftRequest>(INTERACTION_DRAFT_EVENT, { detail: draft }));
}

/** True when a key press lands in a field the person is typing into: the N shortcut stays out of it. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}
