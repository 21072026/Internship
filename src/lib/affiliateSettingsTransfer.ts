// Export and import of a programme's settings (#3622, docs/affiliate-module.md
// § Moving the settings). Server-only. The file's shape and the selection rule are
// pure in src/lib/affiliateSettingsTransferRule.ts.
//
// ONE WRITER PER SECTION, STILL. An import never writes a settings column itself:
// every section goes through the writer a save from the screen uses —
// saveLanding / saveContract / saveCustomerStatusSettings / saveWindowNoticeDays /
// saveReferralUrl / savePlan — so the contrast check, the asset ownership check,
// the contract and plan versions, the currency lock, the plan re-evaluation and
// each writer's own audit row all apply to a file exactly as to a form.
//
// THE PREVIEW is the same reading with nothing written: each section's parser,
// the comparison with what is stored, and the asset checks. The import runs the
// preview first and refuses the whole file when a selected section would not
// save, so a bad file writes nothing.
//
// NOT ATOMIC ACROSS SECTIONS. Each writer has its own transaction (the plan's
// re-evaluation is a queued job), so the sections are applied one after another
// in TRANSFER_SECTIONS order — the plan last. A conflict half-way (another admin
// saving the same section at that moment) stops there and says which sections
// were applied; re-running the import is harmless, since an unchanged section
// writes nothing.
//
// MEDIA. A theme names its uploads by id, and ids differ between environments.
// The file carries the bytes; the import stores each one through
// storeLandingAssetBytes() (the upload's own checks) and points the theme at the
// new ids. An asset whose bytes equal the one the slot shows today is reused, so
// importing the same file twice does not pile up rows. A stored asset the landing
// save then refuses is left to the landing sweep (24 h), like an abandoned upload.

import 'server-only';
import { createHash } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { APP_VERSION } from '@/lib/version';
import { parseCommissionPlan } from '@/lib/affiliateCommissionRule';
import { canonicalContract, contractChanged, parseContractTexts, readStoredContract } from '@/lib/affiliateContractRule';
import { parseCustomerStatusSettings, storedCustomerStatusSettings } from '@/lib/affiliateCustomerStatusRule';
import {
  THEME_MEDIA_KINDS,
  THEME_MEDIA_MAX_PER_ORG,
  canonicalLanding,
  parseLanding,
  readStoredLanding,
  themeMediaRefs,
  type Landing,
  type ThemeMediaSlot,
} from '@/lib/affiliateLandingRule';
import { landingAssetRefusal, storeLandingAssetBytes } from '@/lib/affiliateLandingAssets';
import { parseReferralUrl } from '@/lib/affiliateReferralRule';
import { parseWindowNoticeDays, readWindowNoticeDays } from '@/lib/affiliateWindowNoticeRule';
import {
  AFFILIATE_CURRENCIES,
  AffiliateSettingsError,
  canonicalPlan,
  saveCustomerStatusSettings,
  saveLanding,
  savePlan,
  saveReferralUrl,
  saveWindowNoticeDays,
} from '@/lib/affiliateProgramSettings';
import { AffiliateContractError, saveContract } from '@/lib/affiliateContract';
import {
  SETTINGS_TRANSFER_FORMAT,
  SETTINGS_TRANSFER_MAX_BYTES,
  SETTINGS_TRANSFER_VERSION,
  landingMediaIds,
  presentSections,
  remapLandingMedia,
  type TransferAsset,
  type TransferFile,
  type TransferSection,
  type TransferSections,
} from '@/lib/affiliateSettingsTransferRule';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// ── Export ────────────────────────────────────────────────────────────────────

/**
 * The programme's settings as a transfer file. A section that was never set is
 * left out (an import then leaves that section of the target alone); the media
 * are the ones the saved theme names, nothing else of the org's uploads.
 */
export async function buildSettingsExport(orgId: string, now = new Date()): Promise<TransferFile> {
  const row = await prisma.affiliateProgramSettings.findUnique({
    where: { orgId },
    select: { plan: true, referralUrl: true, landing: true, contract: true, freeMonths: true, passiveAfterDays: true, windowNoticeDays: true },
  });
  const sections: TransferSections = {};
  const assets: TransferAsset[] = [];
  if (row) {
    const landing = readStoredLanding(row.landing);
    if (row.landing !== null) sections.landing = landing;
    const contract = readStoredContract(row.contract);
    if (canonicalContract(contract).length > 0) sections.contract = contract;
    const plan = row.plan ? parseCommissionPlan(row.plan) : null;
    if (plan?.ok) sections.plan = plan.plan;
    // An address never entered is left out, not exported as null: imported, null
    // would CLEAR the target's address and break every partner's link.
    if (row.referralUrl) sections.referralUrl = row.referralUrl;
    sections.customerStatus = storedCustomerStatusSettings(row);
    sections.windowNotice = readWindowNoticeDays(row.windowNoticeDays);

    const ids = [...new Set(themeMediaRefs(landing.theme).map((r) => r.id))];
    if (ids.length > 0) {
      const rows = await prisma.affiliateLandingAsset.findMany({
        where: { orgId, id: { in: ids } },
        select: { id: true, kind: true, contentType: true, data: true },
      });
      for (const a of rows) {
        const bytes = Buffer.from(a.data);
        assets.push({
          id: a.id,
          kind: a.kind === 'video' ? 'video' : 'image',
          contentType: a.contentType,
          size: bytes.length,
          sha256: sha256(bytes),
          data: bytes.toString('base64'),
        });
      }
    }
  }
  return { format: SETTINGS_TRANSFER_FORMAT, version: SETTINGS_TRANSFER_VERSION, exportedAt: now.toISOString(), appVersion: APP_VERSION, sections, assets };
}

/**
 * The request body as JSON, refusing past SETTINGS_TRANSFER_MAX_BYTES while it is
 * read — a declared length is not trusted, the stream is counted.
 */
export async function readTransferBody(request: Request): Promise<{ ok: true; json: unknown } | { ok: false; issue: 'too_large' | 'not_json' }> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > SETTINGS_TRANSFER_MAX_BYTES) return { ok: false, issue: 'too_large' };
  if (!request.body) return { ok: false, issue: 'not_json' };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > SETTINGS_TRANSFER_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      return { ok: false, issue: 'too_large' };
    }
    chunks.push(value);
  }
  try {
    const text = Buffer.concat(chunks).toString('utf8');
    chunks.length = 0; // let the pieces go before the parse makes its own copy
    return { ok: true, json: JSON.parse(text) };
  } catch {
    return { ok: false, issue: 'not_json' };
  }
}

/**
 * One import at a time per organisation in this process. A file can be 50 MB
 * and is decoded more than once, so parallel imports by one admin could crowd
 * the container's memory; a second request while one runs is answered `busy`.
 * Per process on purpose: with two replicas the bound is two, still bounded.
 */
const importsInFlight = new Set<string>();

export async function withImportSlot<T>(orgId: string, run: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  if (importsInFlight.has(orgId)) return { ok: false };
  importsInFlight.add(orgId);
  try {
    return { ok: true, value: await run() };
  } finally {
    importsInFlight.delete(orgId);
  }
}

// ── Preview ───────────────────────────────────────────────────────────────────

export type SectionStatus = 'changed' | 'same' | 'invalid';

export interface SectionPreview {
  section: TransferSection;
  status: SectionStatus;
  /** Why a section is invalid: `<field>:<code>` entries, the field as the section's own parser names it. */
  issues: string[];
  /**
   * For the small settings (referral address, customer status, window notice):
   * the value today and the value the file brings, so a change is seen before it
   * is made. Texts, theme and plan are not repeated here.
   */
  from?: unknown;
  to?: unknown;
}

interface PreparedAsset {
  asset: TransferAsset;
  bytes: Buffer;
}

interface Prepared {
  previews: SectionPreview[];
  /** The decoded media the landing names, by their id in the file. */
  assets: Map<string, PreparedAsset>;
  /** For each file asset id, the id of an equal asset the org already shows in that slot. */
  reuse: Map<string, string>;
}

/** The file's landing with every media id swapped for its content hash — what "same look" compares. */
function landingByContent(landing: Landing, hashOf: (id: string) => string | undefined): string {
  if (!landing.theme) return canonicalLanding(landing);
  const media = Object.fromEntries(
    Object.entries(landing.theme.media).map(([slot, id]) => [slot, id ? (hashOf(id) ?? `missing:${id}`) : null]),
  ) as Record<ThemeMediaSlot, string | null>;
  return canonicalLanding({ ...landing, theme: { ...landing.theme, media } });
}

async function prepare(orgId: string, file: TransferFile): Promise<Prepared> {
  const row = await prisma.affiliateProgramSettings.findUnique({
    where: { orgId },
    select: { plan: true, referralUrl: true, landing: true, contract: true, freeMonths: true, passiveAfterDays: true, windowNoticeDays: true },
  });
  const previews: SectionPreview[] = [];
  const assets = new Map<string, PreparedAsset>();
  const reuse = new Map<string, string>();
  const push = (section: TransferSection, status: SectionStatus, issues: string[] = [], values?: { from: unknown; to: unknown }) =>
    previews.push({ section, status, issues, ...(values ?? {}) });

  for (const section of presentSections(file)) {
    const raw = file.sections[section];
    switch (section) {
      case 'landing': {
        const parsed = parseLanding(raw);
        if (!parsed.ok) {
          push(section, 'invalid', parsed.issues.map((i) => `${i.field}:${i.code}`));
          break;
        }
        // Every slot the theme names must come with its bytes, of a kind the slot takes.
        const issues: string[] = [];
        const byId = new Map(file.assets.map((a) => [a.id, a]));
        for (const { slot, id } of landingMediaIds(raw)) {
          const asset = byId.get(id);
          const kinds = THEME_MEDIA_KINDS[slot as ThemeMediaSlot];
          if (!asset || !kinds?.includes(asset.kind)) {
            issues.push(`theme.media.${slot}:missing`);
            continue;
          }
          if (!assets.has(id)) {
            const bytes = Buffer.from(asset.data, 'base64');
            const refusal = sha256(bytes) !== asset.sha256 ? 'checksum' : landingAssetRefusal(bytes, asset.contentType);
            if (refusal) {
              issues.push(`theme.media.${slot}:${refusal}`);
              continue;
            }
            assets.set(id, { asset, bytes });
          }
        }
        if (issues.length > 0) {
          push(section, 'invalid', issues);
          break;
        }
        // What the org shows today, by content.
        const current = readStoredLanding(row?.landing);
        const currentIds = [...new Set(themeMediaRefs(current.theme).map((r) => r.id))];
        const currentHash = new Map<string, string>();
        if (currentIds.length > 0) {
          const stored = await prisma.affiliateLandingAsset.findMany({ where: { orgId, id: { in: currentIds } }, select: { id: true, data: true } });
          for (const s of stored) currentHash.set(s.id, sha256(Buffer.from(s.data)));
        }
        for (const [id, { asset }] of assets) {
          const match = [...currentHash].find(([, h]) => h === asset.sha256);
          if (match) reuse.set(id, match[0]);
        }
        const fresh = [...assets.keys()].filter((id) => !reuse.has(id)).length;
        if (fresh > 0 && (await prisma.affiliateLandingAsset.count({ where: { orgId } })) + fresh > THEME_MEDIA_MAX_PER_ORG) {
          push(section, 'invalid', ['theme.media:too_many']);
          break;
        }
        const same =
          row?.landing != null &&
          landingByContent(parsed.landing, (id) => assets.get(id)?.asset.sha256) === landingByContent(current, (id) => currentHash.get(id));
        push(section, same ? 'same' : 'changed');
        break;
      }
      case 'contract': {
        const parsed = parseContractTexts(raw);
        if (!parsed.ok) push(section, 'invalid', parsed.issues.map((i) => `${i.locale}:${i.code}`));
        else if (canonicalContract(parsed.texts).length === 0) push(section, 'invalid', ['*:empty']);
        else push(section, contractChanged(row?.contract ?? null, parsed.texts) ? 'changed' : 'same');
        break;
      }
      case 'plan': {
        const parsed = parseCommissionPlan(raw);
        if (!parsed.ok) {
          push(section, 'invalid', parsed.issues.map((i) => `${i.field}:${i.code}`));
          break;
        }
        if (!(AFFILIATE_CURRENCIES as readonly string[]).includes(parsed.plan.currency)) {
          push(section, 'invalid', ['currency:range']);
          break;
        }
        const stored = row?.plan ? parseCommissionPlan(row.plan) : null;
        if (stored?.ok && canonicalPlan(stored.plan) === canonicalPlan(parsed.plan)) {
          push(section, 'same');
          break;
        }
        // The writer's own rule, read ahead: no currency switch once a payment exists.
        if (stored?.ok && stored.plan.currency !== parsed.plan.currency && (await prisma.affiliatePayment.count({ where: { orgId } })) > 0) {
          push(section, 'invalid', ['currency:currency_locked']);
          break;
        }
        push(section, 'changed');
        break;
      }
      case 'referralUrl': {
        const parsed = parseReferralUrl(raw);
        if (!parsed.ok) push(section, 'invalid', [`referralUrl:${parsed.issue}`]);
        else {
          const from = row?.referralUrl ?? null;
          push(section, from === parsed.url ? 'same' : 'changed', [], { from, to: parsed.url });
        }
        break;
      }
      case 'customerStatus': {
        const parsed = parseCustomerStatusSettings(raw);
        if (!parsed.ok) {
          push(section, 'invalid', parsed.issues.map((i) => `${i.field}:${i.code}`));
          break;
        }
        const from = storedCustomerStatusSettings(row);
        const same = !!row && from.freeMonths === parsed.settings.freeMonths && from.passiveAfterDays === parsed.settings.passiveAfterDays;
        push(section, same ? 'same' : 'changed', [], { from, to: parsed.settings });
        break;
      }
      case 'windowNotice': {
        const days = parseWindowNoticeDays(raw);
        if (days === null) push(section, 'invalid', ['windowNoticeDays:range']);
        else {
          const from = readWindowNoticeDays(row?.windowNoticeDays);
          push(section, row && from === days ? 'same' : 'changed', [], { from, to: days });
        }
        break;
      }
    }
  }
  return { previews, assets, reuse };
}

export async function previewSettingsImport(orgId: string, file: TransferFile): Promise<SectionPreview[]> {
  return (await prepare(orgId, file)).previews;
}

// ── Import ────────────────────────────────────────────────────────────────────

export type ImportOutcome =
  | { ok: true; applied: { section: TransferSection; changed: boolean }[] }
  | { ok: false; code: 'invalid'; preview: SectionPreview[] }
  | { ok: false; code: 'conflict' | 'asset_refused'; section: TransferSection; applied: { section: TransferSection; changed: boolean }[] };

/**
 * Applies the selected sections (already checked by resolveSelection()) in apply
 * order. Refuses everything when any selected section is invalid.
 */
export async function applySettingsImport(orgId: string, file: TransferFile, sections: readonly TransferSection[], actorId: string): Promise<ImportOutcome> {
  const prepared = await prepare(orgId, file);
  const selected = prepared.previews.filter((p) => sections.includes(p.section));
  if (selected.some((p) => p.status === 'invalid')) return { ok: false, code: 'invalid', preview: prepared.previews };

  const applied: { section: TransferSection; changed: boolean }[] = [];
  let outcome: ImportOutcome | null = null;
  try {
    outcome = await applyInOrder(orgId, file, sections, prepared, actorId, applied);
    return outcome;
  } finally {
    // Written whatever happened — a stop, a thrown error — once anything may have
    // been written (a section, or an upload before the landing save refused).
    await prisma.auditLog
      .create({
        data: {
          orgId,
          actorId,
          action: 'affiliate.settings.import',
          // Which sections, and which of them changed — never their contents. A stopped
          // import names where it stopped; each writer has audited its own change too.
          detail: JSON.stringify({
            sections,
            changed: applied.filter((a) => a.changed).map((a) => a.section),
            stoppedAt: outcome === null ? 'error' : outcome.ok ? null : 'section' in outcome ? outcome.section : null,
            exportedAt: file.exportedAt,
            appVersion: file.appVersion,
          }),
        },
      })
      .catch(() => {});
  }
}

async function applyInOrder(
  orgId: string,
  file: TransferFile,
  sections: readonly TransferSection[],
  prepared: Prepared,
  actorId: string,
  applied: { section: TransferSection; changed: boolean }[],
): Promise<ImportOutcome> {
  const stop = (code: 'conflict' | 'asset_refused', section: TransferSection): ImportOutcome => ({ ok: false, code, section, applied });

  for (const section of sections) {
    const raw = file.sections[section];
    try {
      switch (section) {
        case 'landing': {
          const ids = new Map(prepared.reuse);
          for (const [fileId, { asset, bytes }] of prepared.assets) {
            if (ids.has(fileId)) continue;
            const stored = await storeLandingAssetBytes(orgId, bytes, asset.contentType);
            if (!stored.ok) return stop('asset_refused', section);
            ids.set(fileId, stored.id);
          }
          const result = await saveLanding(orgId, remapLandingMedia(raw, ids), actorId);
          if (!result.ok) return stop('asset_refused', section);
          applied.push({ section, changed: result.changed });
          break;
        }
        case 'contract': {
          const parsed = parseContractTexts(raw);
          if (!parsed.ok) return stop('conflict', section);
          applied.push({ section, changed: (await saveContract(orgId, parsed.texts, actorId)).changed });
          break;
        }
        case 'customerStatus': {
          const result = await saveCustomerStatusSettings(orgId, raw, actorId);
          if (!result.ok) return stop('conflict', section);
          applied.push({ section, changed: result.changed });
          break;
        }
        case 'windowNotice': {
          const result = await saveWindowNoticeDays(orgId, raw, actorId);
          if (!result.ok) return stop('conflict', section);
          applied.push({ section, changed: result.changed });
          break;
        }
        case 'referralUrl': {
          const result = await saveReferralUrl(orgId, raw, actorId);
          if (!result.ok) return stop('conflict', section);
          applied.push({ section, changed: result.changed });
          break;
        }
        case 'plan': {
          applied.push({ section, changed: (await savePlan(orgId, raw, actorId)).changed });
          break;
        }
      }
    } catch (e) {
      // The writers' own refusals (a concurrent save, the currency lock read in
      // between) stop the import where it is; anything else is a real error.
      if (e instanceof AffiliateSettingsError || e instanceof AffiliateContractError) return stop('conflict', section);
      throw e;
    }
  }
  return { ok: true, applied };
}
