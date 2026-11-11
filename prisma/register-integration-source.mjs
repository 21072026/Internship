// Operator CLI: register (or change) one machine source of one organization —
// the `IntegrationSource` row that `POST /api/integrations/<slug>/events`
// resolves to (#2914, docs/integrations/account-events.md § Registering a
// source).
//
//   node prisma/register-integration-source.mjs --org acme --slug demo-feed --label "Demo feed"            # dry run
//   node prisma/register-integration-source.mjs --org acme --slug demo-feed --label "Demo feed" --apply    # write
//   node prisma/register-integration-source.mjs --org acme --slug demo-feed --key <apiKeyId> --apply      # bind to one key
//   node prisma/register-integration-source.mjs --org acme --slug demo-feed --unbind-key --apply          # any companies:write key
//   node prisma/register-integration-source.mjs --org acme --slug demo-feed --disable --apply             # switch off (404)
//   node prisma/register-integration-source.mjs --list [--org acme]
//
// `--org` takes the organization's slug or id. Every run states whether the
// source is ON: `--disable` switches it off, a run without it switches it (back)
// on. `--label` is required to create a source and optional afterwards; the
// key binding is kept unless `--key` or `--unbind-key` says otherwise.
//
// A DRY RUN unless --apply, idempotent (a second run reports "unchanged"), and
// it refuses loudly rather than guessing:
//   • a slug that is malformed or names a static sibling route → exit 2;
//   • an unknown organization → exit 1;
//   • a --key that is not a live `companies:write` key of THAT organization → exit 1
//     (it could never reach the route, so binding it would switch the source off
//     in silence).
// It WARNS, and still writes, when the organization is not a MARKETING tenant:
// the account-event writer creates marketing accounts, so on another product
// the events would land in a funnel that does not expect them. It also WARNS
// when the source would be enabled next to another enabled source of the same
// organization: every source of one org matches accounts on ONE `external_id`
// space (`Company.externalId`), so two sources that use the same id for
// different accounts would act on one account.
//
// The slug is immutable by design (it keys every stored event's dedupe claim
// and high-water mark); there is no rename — register a new source instead.
//
// The slug rule is the plain-ESM mirror of `normalizeSourceSlug`
// (src/lib/accountEventRule.ts). Scripts cannot import a TS module on the
// server's Node 20, hence the copy; scripts/test/account-event-rule.test.mjs
// compares the two — change both in one commit.
import { PrismaClient } from '@prisma/client';

export const SOURCE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const RESERVED_SOURCE_SLUGS = ['calendar', 'chat', 'google', 'microsoft'];
export const SOURCE_LABEL_MAX = 80;

/** The mirror: the slug lower-cased, or null when no source may carry it. */
export function normalizeSourceSlug(raw) {
  if (typeof raw !== 'string') return null;
  const slug = raw.toLowerCase();
  if (!SOURCE_SLUG_PATTERN.test(slug)) return null;
  if (RESERVED_SOURCE_SLUGS.includes(slug)) return null;
  return slug;
}

/** The mirror of `normalizeSourceLabel`: whitespace collapsed, capped, or null. */
export function normalizeSourceLabel(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, SOURCE_LABEL_MAX).trim();
  return v || null;
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name) => process.argv.includes(`--${name}`);

const USAGE =
  'Usage: node prisma/register-integration-source.mjs --org <slug|id> --slug <slug> [--label "<label>"] ' +
  '[--key <apiKeyId> | --unbind-key] [--disable] [--apply]\n' +
  '       node prisma/register-integration-source.mjs --list [--org <slug|id>]';

async function findOrg(prisma, ref) {
  return prisma.organization.findFirst({
    where: { OR: [{ id: ref }, { slug: ref }] },
    select: { id: true, slug: true, name: true, vertical: true },
  });
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const orgRef = (arg('org') ?? '').trim();

    if (has('list')) {
      const org = orgRef ? await findOrg(prisma, orgRef) : null;
      if (orgRef && !org) {
        console.error(`No organization with slug or id "${orgRef}".`);
        process.exitCode = 1;
        return;
      }
      const rows = await prisma.integrationSource.findMany({
        where: org ? { orgId: org.id } : {},
        select: { slug: true, label: true, enabled: true, apiKeyId: true, org: { select: { slug: true } } },
        orderBy: [{ orgId: 'asc' }, { slug: 'asc' }],
      });
      if (!rows.length) console.log('No integration sources.');
      for (const r of rows) {
        console.log(`${r.org.slug}\t${r.slug}\t${r.label}\t${r.enabled ? 'enabled' : 'DISABLED'}\t${r.apiKeyId ? `key ${r.apiKeyId}` : 'any key'}`);
      }
      return;
    }

    const rawSlug = arg('slug');
    if (!orgRef || !rawSlug) {
      console.error(USAGE);
      process.exitCode = 2;
      return;
    }
    const slug = normalizeSourceSlug(rawSlug);
    if (!slug) {
      const lower = rawSlug.toLowerCase();
      console.error(
        RESERVED_SOURCE_SLUGS.includes(lower)
          ? `"${rawSlug}" is reserved: it is a static route under /api/integrations/ (${RESERVED_SOURCE_SLUGS.join(', ')}).`
          : `"${rawSlug}" is not a valid slug: 2–40 characters of a–z, 0–9 and "-", starting with a letter or digit.`,
      );
      process.exitCode = 2;
      return;
    }
    const labelArg = arg('label');
    const label = labelArg === undefined ? undefined : normalizeSourceLabel(labelArg);
    if (labelArg !== undefined && !label) {
      console.error('--label is empty.');
      process.exitCode = 2;
      return;
    }
    const keyArg = arg('key');
    const unbind = has('unbind-key');
    if (keyArg !== undefined && unbind) {
      console.error('--key and --unbind-key contradict each other.');
      process.exitCode = 2;
      return;
    }
    const enabled = !has('disable');
    const apply = has('apply');

    const org = await findOrg(prisma, orgRef);
    if (!org) {
      console.error(`No organization with slug or id "${orgRef}".`);
      process.exitCode = 1;
      return;
    }
    if (org.vertical !== 'MARKETING') {
      console.warn(
        `WARNING: ${org.slug} is not a MARKETING tenant (vertical ${org.vertical ?? 'INTERNSHIP'}). The account-event writer creates MARKETING ` +
          'accounts and funnel records; events for this org would land in a funnel that does not expect them.',
      );
    }

    if (keyArg !== undefined) {
      const key = await prisma.apiKey.findUnique({
        where: { id: keyArg },
        select: { id: true, orgId: true, scopes: true, revokedAt: true, expiresAt: true },
      });
      const scopes = String(key?.scopes ?? '').split(',').map((s) => s.trim());
      const live = key && !key.revokedAt && (!key.expiresAt || key.expiresAt > new Date());
      if (!key || key.orgId !== org.id || !live || !scopes.includes('companies:write')) {
        console.error(
          `API key ${keyArg} is not a live companies:write key of ${org.slug}; a source bound to it could never be posted to.`,
        );
        process.exitCode = 1;
        return;
      }
    }

    const existing = await prisma.integrationSource.findFirst({
      where: { orgId: org.id, slug },
      select: { id: true, label: true, enabled: true, apiKeyId: true },
    });
    if (!existing && !label) {
      console.error(`--label is required to register a new source ("${slug}" does not exist in ${org.slug} yet).`);
      process.exitCode = 2;
      return;
    }

    const want = {
      label: label ?? existing?.label,
      enabled,
      apiKeyId: unbind ? null : keyArg !== undefined ? keyArg : (existing?.apiKeyId ?? null),
    };
    const describe = (s) => `label="${s.label}", ${s.enabled ? 'enabled' : 'DISABLED'}, ${s.apiKeyId ? `bound to key ${s.apiKeyId}` : 'any companies:write key'}`;

    if (enabled) {
      const siblings = await prisma.integrationSource.findMany({
        where: { orgId: org.id, enabled: true, slug: { not: slug } },
        select: { slug: true },
        orderBy: { slug: 'asc' },
      });
      if (siblings.length > 0) {
        console.warn(
          `WARNING: ${org.slug} already has enabled source(s): ${siblings.map((s) => s.slug).join(', ')}. All sources of one ` +
            'organization match accounts on ONE external_id space: an id two sources use for different accounts is one ' +
            'account to the CRM. Use the same id for the same account, or ids that cannot collide (e.g. a per-source prefix).',
        );
      }
    }

    if (existing) {
      const changed = ['label', 'enabled', 'apiKeyId'].filter((f) => existing[f] !== want[f]);
      if (changed.length === 0) {
        console.log(`unchanged: ${org.slug}/${slug} (${describe(existing)}).`);
        return;
      }
      if (!apply) {
        console.log(`DRY RUN: would update ${org.slug}/${slug}: ${describe(existing)} → ${describe(want)}. Re-run with --apply to write.`);
        return;
      }
      await prisma.integrationSource.update({ where: { id: existing.id }, data: want });
      console.log(`updated: ${org.slug}/${slug} (${describe(want)}).`);
      return;
    }

    if (!apply) {
      console.log(`DRY RUN: would register ${org.slug}/${slug} (${describe(want)}). Re-run with --apply to write.`);
      return;
    }
    await prisma.integrationSource.create({ data: { orgId: org.id, slug, ...want } });
    console.log(`registered: ${org.slug}/${slug} (${describe(want)}). Events go to POST /api/integrations/${slug}/events.`);
  } finally {
    await prisma.$disconnect();
  }
}

// Import-safe: only runs as a CLI, so a test can import the mirrored rule.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
