// The domain that receives `reply+<token>@…` mail, or null when none is
// configured (#2217). Dependency-free so the unit test can load it under plain
// Node (scripts/test/reply-address.test.mjs).
//
// There is deliberately no default: the old hard-coded `crm.ersah.in` outlived
// its mailbox (#2166), so every environment without the variable — a topic
// env, a fresh self-host — minted a Reply-To nobody reads. Null means
// reply-by-email is off, and callers send without a Reply-To.
export function inboundEmailDomain(env: Record<string, string | undefined> = process.env): string | null {
  return env.INBOUND_EMAIL_DOMAIN?.trim() || null;
}
