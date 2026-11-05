// The shape of a chat card on each platform (#1942) — pure, no network, so the
// one rule that matters is unit-tested (e2e/chat-card.unit.spec.ts): a card
// with no action has NO button. A cancelled meeting's card must not keep a
// "Join" button that still opens the room.

export interface CardAction {
  label: string;
  url: string;
}

/** Only an https link becomes a button; anything else would be a broken or unsafe click. */
export function safeAction(action: CardAction | null | undefined): CardAction | null {
  if (!action) return null;
  try {
    const u = new URL(action.url);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
  } catch {
    return null;
  }
  return { label: action.label.slice(0, 75), url: action.url };
}

/**
 * An interactive button (#1951): it posts `actionId` + `value` back to the
 * interaction endpoint (#1948). Slack caps an action_id at 255 and a value at
 * 2000 characters; the envelope parser enforces the same on the way back in.
 */
export interface CardButton {
  label: string;
  actionId: string;
  value: string;
}

/**
 * One free-text field on a card (#1953) — a note typed in the conversation.
 * Slack: an `input` block whose plain_text_input dispatches on Enter, the
 * card's `value` riding as the block_id (Slack hands both back on the
 * block_actions payload). Teams: an `Input.Text` named `input` plus an
 * `Action.Execute` whose data carries `value`; Teams merges the typed text
 * into that data. Either way it arrives as the envelope's `input`.
 */
export interface CardInput {
  actionId: string;
  value: string;
  label: string;
  placeholder: string;
  /** Teams needs a button to submit; Slack submits on Enter. */
  submitLabel: string;
}

/** The longest note a card takes — the envelope refuses anything longer on the way back. */
export const MAX_INPUT = 2000;

function safeInput(input: CardInput | null | undefined): CardInput | null {
  if (!input || !/^[a-z][a-z0-9_.-]{0,63}$/.test(input.actionId) || !/^[A-Za-z0-9_-]{1,64}$/.test(input.value)) return null;
  return { ...input, label: input.label.slice(0, 75), placeholder: input.placeholder.slice(0, 150), submitLabel: input.submitLabel.slice(0, 75) };
}

// Slack takes up to 25 elements in one actions block; an NPS question needs 11 plus Skip (#1953).
const MAX_BUTTONS = 12;

function safeButtons(buttons: CardButton[] | null | undefined): CardButton[] {
  return (buttons ?? [])
    .filter((b) => /^[a-z][a-z0-9_.-]{0,63}$/.test(b.actionId) && b.value.length <= 2000)
    .slice(0, MAX_BUTTONS)
    .map((b) => ({ ...b, label: b.label.slice(0, 75) }));
}

/** Slack Block Kit: the sentence as a section, the link and the buttons as one actions block. `text` stays the notification fallback. */
export function slackBlocks(text: string, action: CardAction | null, buttons?: CardButton[] | null, input?: CardInput | null) {
  const a = safeAction(action);
  const field = safeInput(input);
  const elements = [
    ...(a ? [{ type: 'button', text: { type: 'plain_text', text: a.label }, url: a.url }] : []),
    ...safeButtons(buttons).map((b) => ({ type: 'button', text: { type: 'plain_text', text: b.label }, action_id: b.actionId, value: b.value })),
  ];
  return [
    { type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 3000) } },
    ...(field
      ? [{
          type: 'input',
          block_id: field.value,
          dispatch_action: true,
          label: { type: 'plain_text', text: field.label },
          element: {
            type: 'plain_text_input',
            action_id: field.actionId,
            max_length: MAX_INPUT,
            placeholder: { type: 'plain_text', text: field.placeholder },
            dispatch_action_config: { trigger_actions_on: ['on_enter_pressed'] },
          },
        }]
      : []),
    ...(elements.length > 0 ? [{ type: 'actions', elements }] : []),
  ];
}

/**
 * A Teams Adaptive Card with Universal Actions (`Action.Execute`, verb =
 * actionId) — the card type whose clicks arrive as `adaptiveCard/action`
 * invokes at the one interaction endpoint. A hero card cannot do that.
 */
export function teamsAdaptiveCard(text: string, action: CardAction | null, buttons?: CardButton[] | null, input?: CardInput | null) {
  const a = safeAction(action);
  const field = safeInput(input);
  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body: [
      { type: 'TextBlock', text, wrap: true },
      ...(field ? [{ type: 'Input.Text', id: 'input', label: field.label, placeholder: field.placeholder, isMultiline: true, maxLength: MAX_INPUT }] : []),
    ],
    actions: [
      ...(a ? [{ type: 'Action.OpenUrl', title: a.label, url: a.url }] : []),
      ...(field ? [{ type: 'Action.Execute', title: field.submitLabel, verb: field.actionId, data: { value: field.value } }] : []),
      ...safeButtons(buttons).map((b) => ({ type: 'Action.Execute', title: b.label, verb: b.actionId, data: { value: b.value } })),
    ],
  };
}

/** Bot Framework activity: plain text, plus a hero card whose one button opens the URL — or an Adaptive Card when there are interactive buttons. */
export function teamsActivity(text: string, action: CardAction | null, buttons?: CardButton[] | null) {
  const a = safeAction(action);
  if (safeButtons(buttons).length > 0) {
    return {
      type: 'message',
      text,
      textFormat: 'plain',
      attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: teamsAdaptiveCard(text, action, buttons) }],
    };
  }
  return {
    type: 'message',
    text,
    textFormat: 'plain',
    ...(a
      ? { attachments: [{ contentType: 'application/vnd.microsoft.card.hero', content: { buttons: [{ type: 'openUrl', title: a.label, value: a.url }] } }] }
      : { attachments: [] }),
  };
}
