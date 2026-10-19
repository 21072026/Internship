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
//   node prisma/register-integration-source.mjs --org acme --slug demo-feed --enable --apply              # switch back on
//   node prisma/register-integration-source.mjs --org acme --slug demo-feed --allowed-ips "203.0.113.7,198.51.100.0/24" --apply
//   node prisma/register-integration-source.mjs --org acme --slug demo-feed --allowed-ips none --apply    # any address again
//   node prisma/register-integration-source.mjs --list [--org acme]
//
// `--org` takes the organization's slug or id. Every run states whether the
// source is ON. A new source is registered on unless `--disable`; on an
// existing one the switch is KEPT unless `--enable` or `--disable` says
// otherwise — an organization's admin may switch it on /admin/integrations too
// (#2978), and a run that only changes the allowlist must not undo that. `--label` is required to create a source and optional afterwards; the
// key binding is kept unless `--key` or `--unbind-key` says otherwise; the IP
// allowlist (#2978) likewise unless `--allowed-ips` sets it (`none` clears it).
// The request-signing secret is NOT set here: it is generated on the admin
// screen, which is the one place that shows it (once).
//
// A DRY RUN unless --apply, idempotent (a second run reports "unchanged"), and
// it refuses loudly rather than guessing:
//   • a slug that is malformed or names a static sibling route → exit 2;
//   • an unknown organization → exit 1;
//   • an --allowed-ips entry that is not an IPv4 / IPv6 address or CIDR block,
//     has host bits set, is a /0, or more than 50 entries → exit 2;
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
// compares the two — change both in one commit. The allowlist rule below is the
// same kind of mirror of src/lib/sourceIpAllowlistRule.ts, compared by
// scripts/test/source-ip-allowlist.test.mjs.
import { PrismaClient } from '@prisma/client';

export const SOURCE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const RESERVED_SOURCE_SLUGS = ['calendar', 'google'];
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

// ── The IP allowlist mirror (src/lib/sourceIpAllowlistRule.ts, #2978) ─────────

export const SOURCE_ALLOWLIST_MAX = 50;
const V4_OCTET = /^(0|[1-9]\d{0,2})$/;
const V6_GROUP = /^[0-9a-f]{1,4}$/;
const V4_MASK = (1n << 32n) - 1n;

function parseIpv4(raw) {
  const parts = raw.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const p of parts) {
    if (!V4_OCTET.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

function parseIpv6(raw) {
  const s = raw.toLowerCase();
  if (!s || s.includes('%')) return null;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (part) => {
    if (part === '') return [];
    const out = [];
    const items = part.split(':');
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (i === items.length - 1 && item.includes('.')) {
        const v4 = parseIpv4(item);
        if (v4 === null) return null;
        out.push(Number(v4 >> 16n), Number(v4 & 0xffffn));
        continue;
      }
      if (!V6_GROUP.test(item)) return null;
      out.push(parseInt(item, 16));
    }
    return out;
  };
  const head = groupsOf(halves[0]);
  const tail = halves.length === 2 ? groupsOf(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 2 && halves[0].includes('.')) return null;
  let groups;
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array(missing).fill(0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const g of groups) value = (value << 16n) | BigInt(g);
  return value;
}

export function parseAddress(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/^\[|\]$/g, '');
  if (!s) return null;
  if (!s.includes(':')) {
    const v4 = parseIpv4(s);
    return v4 === null ? null : { family: 4, value: v4 };
  }
  const v6 = parseIpv6(s);
  if (v6 === null) return null;
  if (v6 >> 32n === 0xffffn) return { family: 4, value: v6 & V4_MASK };
  return { family: 6, value: v6 };
}

function formatAddress(addr) {
  if (addr.family === 4) return [24n, 16n, 8n, 0n].map((sh) => String(Number((addr.value >> sh) & 255n))).join('.');
  const groups = [];
  for (let i = 7; i >= 0; i--) groups.push(Number((addr.value >> BigInt(i * 16)) & 0xffffn));
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLen < 2) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLen).join(':')}`;
}

export function parseAllowlistEntry(raw) {
  const s = raw.trim();
  const slash = s.indexOf('/');
  const addrPart = slash >= 0 ? s.slice(0, slash) : s;
  const prefixPart = slash >= 0 ? s.slice(slash + 1) : null;
  const addr = parseAddress(addrPart);
  if (!addr) return { ok: false, code: 'invalid' };
  const mapped = addr.family === 4 && addrPart.includes(':');
  const width = addr.family === 4 ? 32 : 128;
  let prefix = width;
  if (prefixPart !== null) {
    if (!/^\d{1,3}$/.test(prefixPart)) return { ok: false, code: 'invalid' };
    prefix = Number(prefixPart);
    if (mapped) {
      if (prefix < 96 || prefix > 128) return { ok: false, code: 'invalid' };
      prefix -= 96;
    }
    if (prefix > width) return { ok: false, code: 'invalid' };
  }
  if (prefix === 0) return { ok: false, code: 'too_broad' };
  const hostMask = (1n << BigInt(width - prefix)) - 1n;
  if ((addr.value & hostMask) !== 0n) return { ok: false, code: 'host_bits' };
  const text = prefix === width ? formatAddress(addr) : `${formatAddress(addr)}/${prefix}`;
  return { ok: true, entry: { family: addr.family, base: addr.value, prefix, text } };
}

/** The mirror of `parseAllowlist`: canonical entries plus every refusal. */
export function parseAllowlist(input) {
  const raw = input === null || input === undefined ? [] : typeof input === 'string' ? [input] : input;
  const tokens = raw.flatMap((s) => (typeof s === 'string' ? s.split(/[\s,;]+/) : [''])).filter((s) => s !== '');
  const entries = [];
  const errors = [];
  const seen = new Set();
  for (const token of tokens) {
    const parsed = parseAllowlistEntry(token);
    if (!parsed.ok) {
      errors.push({ value: token.slice(0, 100), code: parsed.code });
      continue;
    }
    if (seen.has(parsed.entry.text)) continue;
    seen.add(parsed.entry.text);
    entries.push(parsed.entry);
  }
  if (entries.length > SOURCE_ALLOWLIST_MAX) errors.push({ value: String(entries.length), code: 'too_many' });
  return { entries, errors };
}

/** The mirror of `serializeAllowlist`: the stored column, or null for "no allowlist". */
export function serializeAllowlist(entries) {
  return entries.length ? entries.map((e) => e.text).join(',') : null;
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name) => process.argv.includes(`--${name}`);

const USAGE =
  'Usage: node prisma/register-integration-source.mjs --org <slug|id> --slug <slug> [--label "<label>"] ' +
  '[--key <apiKeyId> | --unbind-key] [--allowed-ips "<ip|cidr>,…" | --allowed-ips none] [--enable | --disable] [--apply]\n' +
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
        select: { slug: true, label: true, enabled: true, apiKeyId: true, allowedIps: true, signingSecret: true, org: { select: { slug: true } } },
        orderBy: [{ orgId: 'asc' }, { slug: 'asc' }],
      });
      if (!rows.length) console.log('No integration sources.');
      for (const r of rows) {
        console.log(
          `${r.org.slug}\t${r.slug}\t${r.label}\t${r.enabled ? 'enabled' : 'DISABLED'}\t${r.apiKeyId ? `key ${r.apiKeyId}` : 'any key'}` +
            `\t${r.allowedIps ? `IPs ${r.allowedIps}` : 'any IP'}\t${r.signingSecret ? 'signed' : 'unsigned'}`,
        );
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
    const ipsArg = arg('allowed-ips');
    let allowedIps; // undefined = keep what is stored
    if (ipsArg !== undefined) {
      if (ipsArg.trim().toLowerCase() === 'none') {
        allowedIps = null;
      } else {
        const parsed = parseAllowlist(ipsArg);
        if (parsed.errors.length || parsed.entries.length === 0) {
          const list = parsed.errors.map((e) => `${e.value} (${e.code})`).join(', ');
          console.error(
            list
              ? `--allowed-ips refused: ${list}. IPv4 / IPv6 addresses or CIDR blocks without host bits, no /0, at most ${SOURCE_ALLOWLIST_MAX}.`
              : '--allowed-ips is empty; pass "none" to allow any address.',
          );
          process.exitCode = 2;
          return;
        }
        allowedIps = serializeAllowlist(parsed.entries);
      }
    }
    const enableFlag = has('enable');
    const disableFlag = has('disable');
    if (enableFlag && disableFlag) {
      console.error('--enable and --disable contradict each other.');
      process.exitCode = 2;
      return;
    }
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
      select: { id: true, label: true, enabled: true, apiKeyId: true, allowedIps: true },
    });
    if (!existing && !label) {
      console.error(`--label is required to register a new source ("${slug}" does not exist in ${org.slug} yet).`);
      process.exitCode = 2;
      return;
    }

    // The switch is kept unless a flag names it; a new source starts on.
    const enabled = disableFlag ? false : enableFlag ? true : (existing?.enabled ?? true);
    const want = {
      label: label ?? existing?.label,
      enabled,
      apiKeyId: unbind ? null : keyArg !== undefined ? keyArg : (existing?.apiKeyId ?? null),
      allowedIps: allowedIps !== undefined ? allowedIps : (existing?.allowedIps ?? null),
    };
    const describe = (s) =>
      `label="${s.label}", ${s.enabled ? 'enabled' : 'DISABLED'}, ${s.apiKeyId ? `bound to key ${s.apiKeyId}` : 'any companies:write key'}, ` +
      `${s.allowedIps ? `allowed IPs ${s.allowedIps}` : 'any IP'}`;

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
      const changed = ['label', 'enabled', 'apiKeyId', 'allowedIps'].filter((f) => existing[f] !== want[f]);
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
