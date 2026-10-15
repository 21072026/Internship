// The sales channels an account sells on (#2408) — THE vocabulary.
//
// Which marketplaces, shop systems and carriers an account uses is the first
// thing sales asks ("do you sell on OTTO?") and the obvious targeting filter
// for a postal campaign (#2697). The list covers the common marketplaces, shop
// systems and carriers of online retail in the markets the product serves.
//
// Keys are STRINGS stored in `CompanyChannel.channel`, never a Prisma enum:
// adding Temu's successor is a change to this file, not a `db push`.
// Labels are brand names and the same in every language, so they live here
// rather than in the i18n dictionaries.
//
// Dependency-free and unit-tested (scripts/test/sales-channels.test.mjs).

export type SalesChannelKind = 'MARKETPLACE' | 'SHOP' | 'CARRIER';

export interface SalesChannel {
  key: string;
  label: string;
  kind: SalesChannelKind;
  /** Other spellings an import file or a person may use. */
  aliases?: readonly string[];
}

export const SALES_CHANNELS: readonly SalesChannel[] = [
  // Marketplaces
  { key: 'amazon', label: 'Amazon', kind: 'MARKETPLACE', aliases: ['amazon.de', 'amazon de', 'amazon fba', 'fba', 'amazon prime', 'amazon_prime'] },
  { key: 'ebay', label: 'eBay', kind: 'MARKETPLACE', aliases: ['ebay.de'] },
  { key: 'otto', label: 'OTTO', kind: 'MARKETPLACE', aliases: ['otto market', 'otto.de'] },
  { key: 'kaufland', label: 'Kaufland', kind: 'MARKETPLACE', aliases: ['kaufland.de', 'real.de'] },
  { key: 'etsy', label: 'Etsy', kind: 'MARKETPLACE' },
  { key: 'temu', label: 'Temu', kind: 'MARKETPLACE' },
  { key: 'tiktok-shop', label: 'TikTok Shop', kind: 'MARKETPLACE', aliases: ['tiktok', 'tiktokshop'] },
  { key: 'about-you', label: 'About You', kind: 'MARKETPLACE', aliases: ['aboutyou'] },
  { key: 'bol', label: 'bol.com', kind: 'MARKETPLACE', aliases: ['bol.com'] },
  { key: 'manomano', label: 'ManoMano', kind: 'MARKETPLACE' },
  { key: 'hood', label: 'Hood', kind: 'MARKETPLACE', aliases: ['hood.de'] },
  { key: 'shop-apotheke', label: 'Shop Apotheke', kind: 'MARKETPLACE', aliases: ['shopapotheke'] },
  { key: 'avocadostore', label: 'Avocadostore', kind: 'MARKETPLACE' },
  // The largest marketplace for sellers who also trade in Turkey.
  { key: 'trendyol', label: 'Trendyol', kind: 'MARKETPLACE' },
  // Shop systems
  { key: 'shopify', label: 'Shopify', kind: 'SHOP' },
  { key: 'shopware', label: 'Shopware', kind: 'SHOP', aliases: ['shopware 5', 'shopware 6', 'shopware5', 'shopware6'] },
  { key: 'woocommerce', label: 'WooCommerce', kind: 'SHOP', aliases: ['woo'] },
  { key: 'prestashop', label: 'PrestaShop', kind: 'SHOP' },
  // Carriers
  { key: 'dhl', label: 'DHL', kind: 'CARRIER' },
  { key: 'deutsche-post', label: 'Deutsche Post', kind: 'CARRIER', aliases: ['post', 'deutschepost'] },
  { key: 'dpd', label: 'DPD', kind: 'CARRIER', aliases: ['dpd depot'] },
  { key: 'gls', label: 'GLS', kind: 'CARRIER', aliases: ['gls shipit'] },
  { key: 'hermes', label: 'Hermes', kind: 'CARRIER' },
  { key: 'ups', label: 'UPS', kind: 'CARRIER' },
  { key: 'fedex', label: 'FedEx', kind: 'CARRIER' },
];

/** USING = sells/ships there today; INTERESTED = wants to; DROPPED = used to. */
export const CHANNEL_STATUSES = ['USING', 'INTERESTED', 'DROPPED'] as const;
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];
/** What an import writes: a file that lists a channel says the merchant uses it. */
export const IMPORT_CHANNEL_STATUS: ChannelStatus = 'USING';

const BY_KEY = new Map(SALES_CHANNELS.map((c) => [c.key, c]));

function aliasKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, ' ');
}

const BY_ALIAS = new Map<string, string>();
for (const c of SALES_CHANNELS) {
  for (const name of [c.key, c.label, ...(c.aliases ?? [])]) BY_ALIAS.set(aliasKey(name), c.key);
  BY_ALIAS.set(aliasKey(c.key.replace(/-/g, ' ')), c.key);
}

/** The channel key a free-text name stands for, or null when it is not one we know. */
export function resolveChannel(raw: string): string | null {
  return BY_ALIAS.get(aliasKey(raw)) ?? null;
}

export function isChannelKey(value: string): boolean {
  return BY_KEY.has(value);
}

export function isChannelStatus(value: string): value is ChannelStatus {
  return (CHANNEL_STATUSES as readonly string[]).includes(value);
}

/** The display label of a key; an unknown (retired) key shows as itself. */
export function channelLabel(key: string): string {
  return BY_KEY.get(key)?.label ?? key;
}

/** Every label, for a "must be one of" message. */
export function channelLabelList(): string {
  return SALES_CHANNELS.map((c) => c.label).join(', ');
}

/**
 * The keys a file row names that the account does not carry yet. An import is
 * ADDITIVE: it never removes a channel and never changes a status a person set
 * (INTERESTED, DROPPED) — the file's list is "these exist", not "only these".
 */
export function channelsToAdd(incoming: readonly string[], existing: readonly string[]): string[] {
  const have = new Set(existing);
  return [...new Set(incoming)].filter((k) => !have.has(k));
}
