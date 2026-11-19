## 2026-11-19 — Tenant mail identity (#1670)

- **Web ownership is not mail verification.** Main has `publicHostVerifiedAt`,
  but no dedicated mail-domain source. Isolate that adapter in
  `orgMailIdentityRule.ts` and require the separate server-owned mail proof;
  the DNS workflow remains #1672.
- **Queue and approval can outlive verification.** Re-read proof without the
  request cache at final transport. Serialize the original platform fallback
  and explicit Reply-To flag, preserving the display name through failover.
- **Record messages instead of sending SMTP in tests.** Inject `transmit`'s
  recording transport and use an isolated synthetic MySQL database. Stage new
  files explicitly before source guards, which inspect `git ls-files`.
