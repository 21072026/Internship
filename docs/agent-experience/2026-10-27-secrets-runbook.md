## 2026-10-27 — secrets inventory: one root secret, not five (#1554)

- **Grep `requireServerSecret` before writing about any "separate" key.** The issue assumed a
  secret-box key and a reply-token secret of their own; both are derived from `NEXTAUTH_SECRET`,
  together with ~18 other HMACs and sealed columns (recovery codes, post-campaign block list, the
  mail queue). A rotation note written from the issue text alone would have been wrong.
- **Topic environments source `preview.env` itself** (`infra/server/topic-deploy.sh`), so they
  share preview's root secret — check the deploy scripts, not the workflow names, for where an env
  comes from.
- **A doc that must cover a file can be held to it by a unit test**:
  `scripts/test/secrets-inventory.test.mjs` fails when a `.env.example` variable is not named in
  `docs/secrets-and-rotation.md` — cheap, and it caught one I had missed.
