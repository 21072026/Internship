// What a chat interaction CLAIMS (#1948), read out of an already-verified body.
// Pure, no I/O: the route verifies the platform signature first and only then
// hands the raw bytes here.
//
// Everything in an envelope is a claim. `externalUserId` and `teamId` are
// LOOKUP KEYS for a verified ChatIdentity (dispatch.ts) — never a credential,
// never written anywhere as a person. `actionId` must be a registered action
// to do anything; `value` is an opaque string the handler validates itself.

export interface InteractionEnvelope {
  /** Slack team_id / Teams tenant id. */
  teamId: string;
  /** Slack U… / Teams AAD object id — the key ChatIdentity.externalUserId holds. */
  externalUserId: string;
  actionId: string;
  value: string | null;
  /** Slack only: where the reply goes (checked again before it is used, respond.ts). */
  responseUrl: string | null;
  /** Teams only: the activity id, so one activity is answered once. */
  activityId: string | null;
}

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const ACTION_ID = /^[a-z][a-z0-9_.-]{0,63}$/;
const MAX_VALUE = 2000;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const id = (v: unknown): string | null => {
  const s = str(v);
  return s && SAFE_ID.test(s) ? s : null;
};
const value = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length <= MAX_VALUE ? s : null;
};

/**
 * Slack's interactivity request: `application/x-www-form-urlencoded` with ONE
 * field, `payload`, holding the JSON. Only `block_actions` (a button) is read;
 * every other type is "not an interaction we take" (null), acknowledged by the
 * route and ignored.
 */
export function parseSlackInteraction(rawBody: string): InteractionEnvelope | null {
  let payload: Record<string, unknown>;
  try {
    const field = new URLSearchParams(rawBody).get('payload');
    if (!field) return null;
    payload = JSON.parse(field);
  } catch {
    return null;
  }
  if (payload?.type !== 'block_actions') return null;
  const team = payload.team as { id?: unknown } | undefined;
  const user = payload.user as { id?: unknown } | undefined;
  const action = Array.isArray(payload.actions) ? (payload.actions[0] as { action_id?: unknown; value?: unknown } | undefined) : undefined;
  const teamId = id(team?.id);
  const externalUserId = id(user?.id);
  const actionId = str(action?.action_id);
  if (!teamId || !externalUserId || !actionId || !ACTION_ID.test(actionId)) return null;
  const v = value(action?.value);
  if (action?.value !== undefined && v === null) return null;
  return { teamId, externalUserId, actionId, value: v, responseUrl: str(payload.response_url), activityId: null };
}

/**
 * A Teams Universal Action: an `invoke` activity named `adaptiveCard/action`
 * whose `value.action` carries the `verb` (our action id) and `data`. The
 * member is `from.aadObjectId` — the id the Graph directory sync stored in
 * ChatIdentity — and the tenant is `channelData.tenant.id`.
 */
export function parseTeamsInteraction(activity: unknown): InteractionEnvelope | null {
  const a = activity as {
    type?: unknown;
    name?: unknown;
    id?: unknown;
    from?: { aadObjectId?: unknown };
    channelData?: { tenant?: { id?: unknown } };
    conversation?: { tenantId?: unknown };
    value?: { action?: { verb?: unknown; data?: unknown } };
  } | null;
  if (!a || a.type !== 'invoke' || a.name !== 'adaptiveCard/action') return null;
  const teamId = id(a.channelData?.tenant?.id ?? a.conversation?.tenantId);
  const externalUserId = id(a.from?.aadObjectId);
  const actionId = str(a.value?.action?.verb);
  if (!teamId || !externalUserId || !actionId || !ACTION_ID.test(actionId)) return null;
  const v = value(a.value?.action?.data);
  if (a.value?.action?.data !== undefined && v === null) return null;
  return { teamId, externalUserId, actionId, value: v, responseUrl: null, activityId: id(a.id) };
}

/** Is this Teams activity an interaction at all (so the messages route hands it over)? */
export function isTeamsInteraction(activity: unknown): boolean {
  const a = activity as { type?: unknown; name?: unknown } | null;
  return !!a && a.type === 'invoke' && a.name === 'adaptiveCard/action';
}

/**
 * Where a Slack reply may go. Slack hands every interaction a `response_url`
 * on hooks.slack.com; anything else in that field is a forged payload trying
 * to make us POST somewhere. `allowInsecureLoopback` is the e2e sink's switch
 * (CHAT_RESPONSE_URL_ALLOW_INSECURE_STUB=1), never set on a deployment.
 */
export function isSlackResponseUrl(url: string | null, allowInsecureLoopback = false): boolean {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol === 'https:' && u.hostname === 'hooks.slack.com' && (u.port === '' || u.port === '443')) return true;
  return allowInsecureLoopback && u.protocol === 'http:' && u.hostname === '127.0.0.1';
}
