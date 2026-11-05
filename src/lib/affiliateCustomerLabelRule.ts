// The customer label a partner sees (docs/affiliate-module.md, #3352). Pure, so
// the admin form and the route read the same limit.
//
// `externalRef` stays the matching key (account events and API payments find a
// customer by it); the label is a separate, admin-written name — a trade name,
// never filled automatically, so no personal data reaches the partner unless an
// admin chose to write it.

export const CUSTOMER_LABEL_MAX = 80;

/** A trimmed label, `null` for "no label", or `undefined` when the input is not one. */
export function parseCustomerLabel(raw: unknown): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== 'string') return undefined;
  // Collapse whitespace: a pasted name with a line break is still one label.
  const label = raw.replace(/\s+/g, ' ').trim();
  if (!label) return null;
  return label.length > CUSTOMER_LABEL_MAX ? undefined : label;
}
