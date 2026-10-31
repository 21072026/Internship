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

// Slack takes up to 25 elements in one actions block; an NPS question needs 11 plus Skip (#1953).
const MAX_BUTTONS = 12;

function safeButtons(buttons: CardButton[] | null | undefined): CardButton[] {
  return (buttons ?? [])
    .filter((b) => /^[a-z][a-z0-9_.-]{0,63}$/.test(b.actionId) && b.value.length <= 2000)
    .slice(0, MAX_BUTTONS)
    .map((b) => ({ ...b, label: b.label.slice(0, 75) }));
}

/** Slack Block Kit: the sentence as a section, the link and the buttons as one actions block. `text` stays the notification fallback. */
export function slackBlocks(text: string, action: CardAction | null, buttons?: CardButton[] | null) {
  const a = safeAction(action);
  const elements = [
    ...(a ? [{ type: 'button', text: { type: 'plain_text', text: a.label }, url: a.url }] : []),
    ...safeButtons(buttons).map((b) => ({ type: 'button', text: { type: 'plain_text', text: b.label }, action_id: b.actionId, value: b.value })),
  ];
  return [
    { type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 3000) } },
    ...(elements.length > 0 ? [{ type: 'actions', elements }] : []),
  ];
}

/**
 * A Teams Adaptive Card with Universal Actions (`Action.Execute`, verb =
 * actionId) — the card type whose clicks arrive as `adaptiveCard/action`
 * invokes at the one interaction endpoint. A hero card cannot do that.
 */
export function teamsAdaptiveCard(text: string, action: CardAction | null, buttons?: CardButton[] | null) {
  const a = safeAction(action);
  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body: [{ type: 'TextBlock', text, wrap: true }],
    actions: [
      ...(a ? [{ type: 'Action.OpenUrl', title: a.label, url: a.url }] : []),
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
