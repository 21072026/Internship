# 2026-10-29 — Teams directory via Graph (#3327)

- A no-network stub client (`CHAT_APPS_STUB_CLIENT=1`) that replaces a whole platform client hides
  any method you later want to drive against a protocol stub. Compose instead: keep the stub for
  sends and revokes, and hand the one method that has its own stub endpoint back to the real
  implementation (`{ ...STUB_CLIENT, listMembers: teamsClient.listMembers }`).
- Reuse one mock process for one vendor (Bot Framework JWKS + Entra token + Graph users) — one more
  webServer entry and port per vendor is enough.
