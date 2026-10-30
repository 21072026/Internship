## 2026-10-30 — alt text for announcement and newsletter images (#3388)

- **A JSON PATCH and a multipart PATCH should share one zod schema.** The announcement edit form sends
  JSON while the image swap sends multipart; putting `imageAlt` into the multipart `fields` object (not a
  side channel) let one `schema.safeParse` validate both shapes, including the 500-character cap.
- **Updating a child row that may not exist: `updateMany` on the child, not a nested `update`.** A nested
  `image: { update: … }` throws P2025 when no image is attached; `announcementImage.updateMany({ where:
  { announcementId } })` is a no-op instead.
- **Cold `next dev` compiles still make first sign-ins time out locally** — run new specs with
  `--retries=2` and read which attempt failed and where before calling anything a regression.
