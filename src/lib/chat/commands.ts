import catalog from './chatApp.json';

// The chat commands (#1956), from the ONE list both the dispatcher and the
// manifest generator read (chatApp.json). Pure — no I/O.
//
// A command is not a second door: `/interncrm status` (Slack) or `status`
// typed to the Teams bot becomes an envelope whose action is `command.status`,
// and runs through the SAME dispatcher as a card button (#1948) — signature,
// replay window, rate limit, the verified ChatIdentity, runWithOrg — then a
// handler that asks the app's own services.

export const COMMAND_NAMES = catalog.commands.map((c) => c.name) as readonly string[];
export const SLASH_COMMAND = catalog.slash;

/** The action id a typed command runs: a known name, else `command.help`. */
export function commandActionId(text: string | null | undefined): string {
  const word = (text ?? '')
    .replace(/<at>[^<]*<\/at>/gi, ' ')
    .trim()
    .split(/\s+/)[0]
    ?.toLowerCase()
    .replace(/^\//, '');
  return word && COMMAND_NAMES.includes(word) ? `command.${word}` : 'command.help';
}
