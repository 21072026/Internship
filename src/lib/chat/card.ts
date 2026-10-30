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

/** Slack Block Kit: the sentence as a section, the action as a link button. `text` stays the notification fallback. */
export function slackBlocks(text: string, action: CardAction | null) {
  const a = safeAction(action);
  return [
    { type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 3000) } },
    ...(a ? [{ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: a.label }, url: a.url }] }] : []),
  ];
}

/** Bot Framework activity: plain text, plus a hero card whose one button opens the URL. */
export function teamsActivity(text: string, action: CardAction | null) {
  const a = safeAction(action);
  return {
    type: 'message',
    text,
    textFormat: 'plain',
    ...(a
      ? { attachments: [{ contentType: 'application/vnd.microsoft.card.hero', content: { buttons: [{ type: 'openUrl', title: a.label, value: a.url }] } }] }
      : { attachments: [] }),
  };
}
