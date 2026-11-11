# Internship CRM — Zapier app

The Zapier app over the public API (`/api/v1`, #2004). Everything about it —
versioning, testing against a PR environment, the breaking-change procedure and
the directory submission — is in [`docs/zapier.md`](../../docs/zapier.md).

```bash
npm ci
npm run validate   # zapier-platform validate --without-style
npm test           # offline, every request answered by nock
ICRM_API_KEY=icrm_… npm run smoke   # against preview (or ICRM_BASE_URL=https://pr<N>.interncrm.com)
```
