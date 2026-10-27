// The settings half of the terminology layer (#1629) — see src/lib/terminology.ts
// for the rule. SERVER-ONLY: it reads the settings chain (Prisma, async hooks).
//
// `terminology` is ONE setting row per layer holding every locale, resolved
// through resolveSettingRaw() (programme → org → global → '') — so a programme
// that stores a value replaces the org's whole document, it does not merge with
// it, the same as every other setting in the chain. The read shares the
// request's settings memo: one query per scope per request, whatever else the
// page reads.

import { resolveSettingRaw, type SettingsScope } from '@/lib/settingsResolver';
import { parseTerminology, type Terminology } from '@/lib/terminology';
import { DEFAULT_VERTICAL, type VerticalKey } from '@/lib/verticals';

/** The parsed terminology for `scope`; `{}` when nothing is stored or it does not parse. */
export async function resolveTerminology(scope: SettingsScope): Promise<Terminology> {
  try {
    return parseTerminology(await resolveSettingRaw('terminology', scope));
  } catch {
    // A failed settings read degrades to the dictionary's own words.
    return {};
  }
}

/**
 * The terminology a dictionary for `orgId` in `vertical` carries: none without
 * an org (a signed-out page, an org-less mail) and none outside INTERNSHIP,
 * whose vertical overlay already owns its nouns.
 */
export async function terminologyFor(
  vertical: VerticalKey | null | undefined,
  scope: SettingsScope,
): Promise<Terminology> {
  if ((vertical ?? DEFAULT_VERTICAL) !== DEFAULT_VERTICAL || !scope.orgId) return {};
  return resolveTerminology(scope);
}
