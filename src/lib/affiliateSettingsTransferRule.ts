// Moving a programme's settings between environments (#3622, docs/affiliate-module.md
// § Moving the settings). Pure: the file's shape, what may be selected, and the
// asset-id remapping. The server half (src/lib/affiliateSettingsTransfer.ts) reads
// the rows, checks every section with its own writer's parser and writes through
// those writers only.
//
// THE FILE is one JSON document. The media (logo, hero, showcase) travel inside it
// base64-encoded: they are PNG/JPEG/WebP/MP4/WebM, compressed already, so a zip
// would save nothing and would only add an archive parser (and its path and
// decompression-bomb hazards) in front of the import. Each asset carries its
// SHA-256, so a damaged or edited file is refused rather than half-applied.
//
// WHAT IS NEVER IN IT: partners, customers, payments, commissions, payouts,
// applications, acceptances — no person and no money that happened. The
// organisation's name, id and host are not in it either; only the app version and
// the export time, so a file says where it came from without naming a tenant.
//
// THE PLAN is the one section that changes money. It is never selected by default,
// and the server refuses an import that selects it without `confirmPlan`.

import { ASSET_ID_RE, THEME_MEDIA_MAX_BYTES, THEME_MEDIA_SLOTS, themeMediaKind } from '@/lib/affiliateLandingRule';

export const SETTINGS_TRANSFER_FORMAT = 'affiliate-settings';
export const SETTINGS_TRANSFER_VERSION = 1;

/** The sections, in the order an import applies them; the plan last, so it lands only when the rest did. */
export const TRANSFER_SECTIONS = ['landing', 'contract', 'customerStatus', 'windowNotice', 'referralUrl', 'plan'] as const;
export type TransferSection = (typeof TRANSFER_SECTIONS)[number];

/**
 * The largest file accepted: three media slots at their limits (5 + 15 + 15 MB),
 * base64's third on top, and room for the texts.
 */
export const SETTINGS_TRANSFER_MAX_BYTES = 50 * 1024 * 1024;

export interface TransferAsset {
  /** The asset's id in the exporting environment; the theme names it. */
  id: string;
  kind: 'image' | 'video';
  contentType: string;
  size: number;
  /** Hex SHA-256 of the bytes. */
  sha256: string;
  /** The bytes, base64. */
  data: string;
}

export interface TransferSections {
  landing?: unknown;
  contract?: unknown;
  plan?: unknown;
  referralUrl?: unknown;
  customerStatus?: unknown;
  windowNotice?: unknown;
}

export interface TransferFile {
  format: typeof SETTINGS_TRANSFER_FORMAT;
  version: typeof SETTINGS_TRANSFER_VERSION;
  exportedAt: string;
  appVersion: string;
  sections: TransferSections;
  assets: TransferAsset[];
}

export type TransferFileIssue =
  | 'not_json'
  | 'format' // not one of our files
  | 'version' // a format version this build does not read
  | 'sections'
  | 'assets'
  | 'asset_invalid' // an asset entry with a bad id, type, size or hash
  | 'asset_duplicate';

const SHA256_RE = /^[a-f0-9]{64}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The decoded byte length of a base64 string (no decoding). */
export function base64ByteLength(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return (b64.length / 4) * 3 - pad;
}

function parseAsset(raw: unknown): TransferAsset | null {
  if (!isObject(raw)) return null;
  const { id, kind, contentType, size, sha256, data } = raw;
  if (typeof id !== 'string' || !ASSET_ID_RE.test(id)) return null;
  if (typeof contentType !== 'string') return null;
  const declared = themeMediaKind(contentType);
  if (!declared || kind !== declared) return null;
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0 || size > THEME_MEDIA_MAX_BYTES[declared]) return null;
  if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) return null;
  if (typeof data !== 'string' || data.length % 4 !== 0 || !BASE64_RE.test(data)) return null;
  if (base64ByteLength(data) !== size) return null;
  return { id, kind: declared, contentType: contentType.toLowerCase(), size, sha256, data };
}

/**
 * The envelope and the assets' shape. The sections' contents are NOT judged here:
 * each is handed to its own writer's parser by the server, the same one a save
 * from the screen goes through.
 */
export function parseTransferFile(raw: unknown): { ok: true; file: TransferFile } | { ok: false; issue: TransferFileIssue } {
  if (!isObject(raw) || raw.format !== SETTINGS_TRANSFER_FORMAT) return { ok: false, issue: 'format' };
  if (raw.version !== SETTINGS_TRANSFER_VERSION) return { ok: false, issue: 'version' };
  if (!isObject(raw.sections)) return { ok: false, issue: 'sections' };
  const sections: TransferSections = {};
  for (const [key, value] of Object.entries(raw.sections)) {
    if (!(TRANSFER_SECTIONS as readonly string[]).includes(key)) return { ok: false, issue: 'sections' };
    if (value !== undefined) sections[key as TransferSection] = value;
  }
  const rawAssets = raw.assets ?? [];
  // At most one asset per media slot: the theme cannot name more.
  if (!Array.isArray(rawAssets) || rawAssets.length > THEME_MEDIA_SLOTS.length) return { ok: false, issue: 'assets' };
  const assets: TransferAsset[] = [];
  for (const a of rawAssets) {
    const asset = parseAsset(a);
    if (!asset) return { ok: false, issue: 'asset_invalid' };
    if (assets.some((x) => x.id === asset.id)) return { ok: false, issue: 'asset_duplicate' };
    assets.push(asset);
  }
  return {
    ok: true,
    file: {
      format: SETTINGS_TRANSFER_FORMAT,
      version: SETTINGS_TRANSFER_VERSION,
      exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
      appVersion: typeof raw.appVersion === 'string' ? raw.appVersion : '',
      sections,
      assets,
    },
  };
}

/** The sections a file carries, in apply order. */
export function presentSections(file: Pick<TransferFile, 'sections'>): TransferSection[] {
  return TRANSFER_SECTIONS.filter((s) => file.sections[s] !== undefined);
}

/**
 * Sections never pre-selected: the plan (it changes what partners earn; the server
 * also wants `confirmPlan`) and the contract (a new version locks every partner's
 * portal until they accept it again). The admin ticks them on purpose.
 */
export const NOT_PRESELECTED: readonly TransferSection[] = ['plan', 'contract'];

/** What the screen pre-selects: every section the file carries except NOT_PRESELECTED. */
export function defaultSelection(present: readonly TransferSection[]): TransferSection[] {
  return present.filter((s) => !NOT_PRESELECTED.includes(s));
}

export type SelectionIssue = 'unknown_section' | 'not_in_file' | 'empty' | 'plan_unconfirmed';

/**
 * The sections an import may apply. `requested` is a comma list from the request;
 * it must name only sections the file carries, at least one, and the plan only
 * with `confirmPlan` — the server's own check, whatever the screen did.
 */
export function resolveSelection(
  requested: string | null | undefined,
  present: readonly TransferSection[],
  confirmPlan: boolean,
): { ok: true; sections: TransferSection[] } | { ok: false; issue: SelectionIssue } {
  const names = (requested ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) return { ok: false, issue: 'empty' };
  for (const n of names) {
    if (!(TRANSFER_SECTIONS as readonly string[]).includes(n)) return { ok: false, issue: 'unknown_section' };
    if (!present.includes(n as TransferSection)) return { ok: false, issue: 'not_in_file' };
  }
  if (names.includes('plan') && !confirmPlan) return { ok: false, issue: 'plan_unconfirmed' };
  return { ok: true, sections: TRANSFER_SECTIONS.filter((s) => names.includes(s)) };
}

/** The asset ids the file's landing names, slot by slot (a raw read: the landing's own parser judges the rest). */
export function landingMediaIds(landing: unknown): { slot: string; id: string }[] {
  if (!isObject(landing) || !isObject(landing.theme) || !isObject(landing.theme.media)) return [];
  return Object.entries(landing.theme.media).flatMap(([slot, id]) => (typeof id === 'string' && id !== '' ? [{ slot, id }] : []));
}

/** The landing with its theme's asset ids replaced through `map` (an id not in the map is left as it is). */
export function remapLandingMedia(landing: unknown, map: ReadonlyMap<string, string>): unknown {
  if (!isObject(landing) || !isObject(landing.theme) || !isObject(landing.theme.media)) return landing;
  const media = Object.fromEntries(
    Object.entries(landing.theme.media).map(([slot, id]) => [slot, typeof id === 'string' && map.has(id) ? map.get(id) : id]),
  );
  return { ...landing, theme: { ...landing.theme, media } };
}

/** The download's file name: the date only, never the organisation. */
export function transferFileName(now: Date): string {
  return `affiliate-settings-${now.toISOString().slice(0, 10)}.json`;
}
