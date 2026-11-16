// The "New lead" form's naming rule (#3821) — ONE rule, read by the dialog
// (NewMarketingLeadDialog) and by both routes behind it (POST /api/sales/leads,
// POST /api/admin/marketing-accounts), so the form and the server cannot
// disagree about what a valid lead is.
//
//   • at least one of the company name and the contact name is given;
//   • only a contact name → the account is named after the contact (a sole
//     trader, a person met at a fair without a company card);
//   • only a company name → the contact stays empty — the company name is NOT
//     copied into the contact, which would invent a person.
//
// Dependency-free so a unit test can load it under plain Node.

export type NewLeadNames =
  | { ok: true; name: string; contactName: string | undefined }
  | { ok: false; code: 'name_required' };

export function resolveNewLeadNames(input: { name?: string | null; contactName?: string | null }): NewLeadNames {
  const name = (input.name ?? '').trim();
  const contactName = (input.contactName ?? '').trim();
  if (!name && !contactName) return { ok: false, code: 'name_required' };
  return { ok: true, name: name || contactName, contactName: contactName || undefined };
}
