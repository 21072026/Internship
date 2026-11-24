## 2026-11-18 — consent-aware conversion events (#1388)

- **Inspect shipped helpers before adding another analytics layer.** #1391 already
  supplies `track.ts` and DemoLink. Extend it, preserve the shipped event name,
  and constrain its formerly generic property bag at both type and runtime levels.
- **Page mounts can precede SDK load.** Public page events listen for the loader
  lifecycle while mounted; form conversions are never queued for later consent.
- **Auth URLs carry credentials.** Keep analytics loaders out of auth/CRM shells
  and remove consumed query credentials before successful conversion calls.
- **Public env values need direct references.** Next inlines `process.env.NEXT_PUBLIC_*`,
  not reads through an aliased env object. Keep explicit default config reads.
